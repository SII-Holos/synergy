/**
 * Apply a parsed list of Edits to a text body and return the post-edit lines
 * plus any diagnostic warnings. Pure function: no FS, no mutation of the input.
 *
 * Replacement groups are first normalized by repairReplacementBoundaries,
 * which absorbs common model mistakes where a payload restates unchanged range
 * boundaries or duplicates/drops structural closers.
 */
import { afterInsertLandingShiftWarning, blockInsertLandingShiftWarning, UNRESOLVED_BLOCK_INTERNAL } from "./messages"
import { cloneCursor } from "./tokenizer"
import type { Anchor, ApplyResult, Cursor, Edit } from "./types"

type LineOrigin = "original" | "insert" | "replacement"

type InsertEdit = Extract<Edit, { kind: "insert" }>
type DeleteEdit = Extract<Edit, { kind: "delete" }>
type AppliedEdit = InsertEdit | DeleteEdit

interface IndexedEdit {
  edit: AppliedEdit
  idx: number
}

function isReplacementInsert(edit: Edit): edit is InsertEdit & { mode: "replacement" } {
  return edit.kind === "insert" && edit.mode === "replacement"
}

function getCursorAnchors(cursor: Cursor): Anchor[] {
  return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : []
}

function getEditAnchors(edit: AppliedEdit): Anchor[] {
  if (edit.kind === "delete") return [edit.anchor]
  return getCursorAnchors(edit.cursor)
}

function trailingPhantomLine(fileLines: readonly string[]): number {
  return fileLines.length > 1 && fileLines[fileLines.length - 1] === "" ? fileLines.length : 0
}

function dropTrailingPhantomDeletes(edits: AppliedEdit[], fileLines: readonly string[]): AppliedEdit[] {
  const phantomLine = trailingPhantomLine(fileLines)
  if (phantomLine === 0) return edits
  return edits.filter((edit) => edit.kind !== "delete" || edit.anchor.line !== phantomLine)
}

function validateLineBounds(edits: readonly AppliedEdit[], fileLines: readonly string[]): void {
  for (const edit of edits) {
    for (const anchor of getEditAnchors(edit)) {
      if (anchor.line < 1 || anchor.line > fileLines.length) {
        throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`)
      }
    }
  }
}

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
  if (edit.kind === "delete") return { ...edit, anchor: { ...edit.anchor }, index }
  return { ...edit, cursor: cloneCursor(edit.cursor), index }
}

function insertAtStart(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): void {
  if (lines.length === 0) return
  const origins = lines.map((): LineOrigin => "insert")
  if (fileLines.length === 1 && fileLines[0] === "") {
    fileLines.splice(0, 1, ...lines)
    lineOrigins.splice(0, 1, ...origins)
    return
  }
  fileLines.splice(0, 0, ...lines)
  lineOrigins.splice(0, 0, ...origins)
}

function insertAtEnd(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): number | undefined {
  if (lines.length === 0) return undefined
  const origins = lines.map((): LineOrigin => "insert")
  if (fileLines.length === 1 && fileLines[0] === "") {
    fileLines.splice(0, 1, ...lines)
    lineOrigins.splice(0, 1, ...origins)
    return 1
  }
  const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === ""
  const insertIndex = hasTrailingNewline ? fileLines.length - 1 : fileLines.length
  fileLines.splice(insertIndex, 0, ...lines)
  lineOrigins.splice(insertIndex, 0, ...origins)
  return insertIndex + 1
}

function bucketAnchorEditsByLine(edits: IndexedEdit[]): Map<number, IndexedEdit[]> {
  const byLine = new Map<number, IndexedEdit[]>()
  for (const entry of edits) {
    const line =
      entry.edit.kind === "delete"
        ? entry.edit.anchor.line
        : entry.edit.cursor.kind === "before_anchor" || entry.edit.cursor.kind === "after_anchor"
          ? entry.edit.cursor.anchor.line
          : 0
    const bucket = byLine.get(line)
    if (bucket) bucket.push(entry)
    else byLine.set(line, [entry])
  }
  return byLine
}

// ── Replacement-boundary repair ──

export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/

const JSX_CLOSER_RE = /^\s*(?:<\/>|<\/[A-Za-z][\w.:-]*>|\/>)\s*[;,]?\s*$/
const JSX_NAMED_CLOSER_RE = /^\s*<\/([A-Za-z][\w.:-]*)>\s*[;,]?\s*$/
const JSX_FRAGMENT_CLOSER_RE = /^\s*<\/>\s*[;,]?\s*$/

function isStructuralCloserLine(text: string): boolean {
  return STRUCTURAL_CLOSER_RE.test(text) || JSX_CLOSER_RE.test(text)
}

function jsxCloserName(text: string): string | undefined {
  if (JSX_FRAGMENT_CLOSER_RE.test(text)) return ""
  const match = JSX_NAMED_CLOSER_RE.exec(text)
  return match?.[1]
}

interface JsxPayloadTag {
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
}

function isJsxTagStart(text: string, index: number): boolean {
  const next = text[index + 1]
  return next === ">" || next === "/" || (next >= "A" && next <= "Z") || (next >= "a" && next <= "z")
}

function findJsxTagEnd(text: string, start: number): number {
  let quote: string | undefined
  let braces = 0
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
    } else if (ch === "{") {
      braces++
    } else if (ch === "}" && braces > 0) {
      braces--
    } else if (ch === ">" && braces === 0) return i
  }
  return -1
}

function parseJsxPayloadTag(raw: string): JsxPayloadTag | undefined {
  if (raw === "<>") return { name: "", closing: false, selfClosing: false }
  if (raw === "</>") return { name: "", closing: true, selfClosing: false }
  const closing = raw.startsWith("</")
  const nameStart = closing ? 2 : 1
  let nameEnd = nameStart
  while (nameEnd < raw.length && /[\w.:-]/.test(raw[nameEnd])) nameEnd++
  if (nameEnd === nameStart) return undefined
  return { name: raw.slice(nameStart, nameEnd), closing, selfClosing: !closing && /\/>\s*$/.test(raw) }
}

function readJsxPayloadTags(text: string): JsxPayloadTag[] {
  const tags: JsxPayloadTag[] = []
  for (let start = text.indexOf("<"); start >= 0; start = text.indexOf("<", start + 1)) {
    if (!isJsxTagStart(text, start)) continue
    const end = findJsxTagEnd(text, start)
    if (end < 0) break
    const tag = parseJsxPayloadTag(text.slice(start, end + 1))
    if (tag) tags.push(tag)
    start = end
  }
  return tags
}

function payloadHasJsxOpenerForEcho(payloadPrefix: readonly string[], echoLines: readonly string[]): boolean {
  const openTags: string[] = []
  for (const tag of readJsxPayloadTags(payloadPrefix.join("\n"))) {
    if (tag.closing) {
      if (openTags[openTags.length - 1] === tag.name) openTags.pop()
    } else if (!tag.selfClosing) openTags.push(tag.name)
  }
  for (const line of echoLines) {
    const name = jsxCloserName(line)
    if (name !== undefined && openTags.includes(name)) return true
  }
  return false
}

interface DelimiterBalance {
  paren: number
  bracket: number
  brace: number
}

function computeDelimiterBalance(lines: readonly string[]): DelimiterBalance {
  const balance: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 }
  let inBlockComment = false
  let quote = ""
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inBlockComment) {
        if (ch === "*" && line[i + 1] === "/") {
          inBlockComment = false
          i++
          continue
        }
      }
      if (quote) {
        if (ch === "\\") i++
        else if (ch === quote) quote = ""
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        continue
      }
      if (ch === "/" && line[i + 1] === "/") break
      if (ch === "/" && line[i + 1] === "*") {
        inBlockComment = true
        i++
        continue
      }
      switch (ch) {
        case "(":
          balance.paren++
          break
        case ")":
          balance.paren--
          break
        case "[":
          balance.bracket++
          break
        case "]":
          balance.bracket--
          break
        case "{":
          balance.brace++
          break
        case "}":
          balance.brace--
          break
      }
    }
    if (quote === '"' || quote === "'") quote = ""
  }
  return balance
}

function balanceDelta(a: DelimiterBalance, b: DelimiterBalance): DelimiterBalance {
  return { paren: a.paren - b.paren, bracket: a.bracket - b.bracket, brace: a.brace - b.brace }
}

function balanceNegate(a: DelimiterBalance): DelimiterBalance {
  return { paren: -a.paren, bracket: -a.bracket, brace: -a.brace }
}

function balanceEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
  return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace
}

function balanceIsZero(a: DelimiterBalance): boolean {
  return a.paren === 0 && a.bracket === 0 && a.brace === 0
}

interface ReplacementGroup {
  insertIndices: number[]
  deleteIndices: number[]
  payload: string[]
  startLine: number
  endLine: number
}

function findReplacementGroup(edits: readonly AppliedEdit[], start: number): ReplacementGroup | undefined {
  const first = edits[start]
  if (first?.kind !== "insert" || first.mode !== "replacement" || first.cursor.kind !== "before_anchor")
    return undefined
  const { lineNum } = first
  const anchorLine = first.cursor.anchor.line
  const insertIndices: number[] = []
  const payload: string[] = []
  let i = start
  for (; i < edits.length; i++) {
    const edit = edits[i]
    if (edit.kind !== "insert" || edit.mode !== "replacement" || edit.lineNum !== lineNum) break
    if (edit.cursor.kind !== "before_anchor" || edit.cursor.anchor.line !== anchorLine) break
    insertIndices.push(i)
    payload.push(edit.text)
  }
  const deleteIndices: number[] = []
  let expectedLine = anchorLine
  for (; i < edits.length; i++) {
    const edit = edits[i]
    if (edit.kind !== "delete" || edit.lineNum !== lineNum || edit.anchor.line !== expectedLine) break
    deleteIndices.push(i)
    expectedLine++
  }
  if (deleteIndices.length === 0) return undefined
  return {
    insertIndices,
    deleteIndices,
    payload,
    startLine: anchorLine,
    endLine: anchorLine + deleteIndices.length - 1,
  }
}

function findDuplicateSuffix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
  if (balanceIsZero(delta)) return 0
  const { payload, endLine } = group
  const maxK = Math.min(payload.length, fileLines.length - endLine)
  for (let k = maxK; k >= 1; k--) {
    let matches = true
    for (let t = 0; t < k; t++) {
      if (payload[payload.length - k + t] !== fileLines[endLine + t]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    if (balanceEqual(computeDelimiterBalance(payload.slice(payload.length - k)), delta)) return k
  }
  return 0
}

function findDuplicatePrefix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
  if (balanceIsZero(delta)) return 0
  const { payload, startLine } = group
  const maxJ = Math.min(payload.length, startLine - 1)
  for (let j = maxJ; j >= 1; j--) {
    let matches = true
    for (let t = 0; t < j; t++) {
      if (payload[t] !== fileLines[startLine - 1 - j + t]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    if (balanceEqual(computeDelimiterBalance(payload.slice(0, j)), delta)) return j
  }
  return 0
}

function payloadEndsWithDeletedSuffix(group: ReplacementGroup, fileLines: readonly string[], count: number): boolean {
  if (group.payload.length < count) return false
  const deletedStart = group.endLine - count
  const payloadStart = group.payload.length - count
  for (let offset = 0; offset < count; offset++) {
    if (group.payload[payloadStart + offset] !== fileLines[deletedStart + offset]) return false
  }
  return true
}

function findDroppedSuffixClosers(
  group: ReplacementGroup,
  fileLines: readonly string[],
  delta: DelimiterBalance,
): number {
  const wanted = balanceNegate(delta)
  const maxM = group.deleteIndices.length
  for (let m = 1; m <= maxM; m++) {
    if (!STRUCTURAL_CLOSER_RE.test(fileLines[group.endLine - m] ?? "")) break
    if (payloadEndsWithDeletedSuffix(group, fileLines, m)) continue
    if (balanceEqual(computeDelimiterBalance(fileLines.slice(group.endLine - m, group.endLine)), wanted)) return m
  }
  return 0
}

interface BoundaryEcho {
  leading: number
  trailing: number
}

function hasNonWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) return true
  }
  return false
}

function countDuplicateLeadingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
  const { payload, startLine } = group
  const max = Math.min(payload.length, startLine - 1)
  for (let count = max; count >= 1; count--) {
    let matches = true
    let hasContent = false
    for (let offset = 0; offset < count; offset++) {
      const line = payload[offset]
      if (line !== fileLines[startLine - 1 - count + offset]) {
        matches = false
        break
      }
      hasContent ||= hasNonWhitespace(line)
    }
    if (matches && hasContent) return count
  }
  return 0
}

function countDuplicateTrailingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
  const { payload, endLine } = group
  const max = Math.min(payload.length, fileLines.length - endLine)
  for (let count = max; count >= 1; count--) {
    let matches = true
    let hasContent = false
    for (let offset = 0; offset < count; offset++) {
      const line = payload[payload.length - count + offset]
      if (line !== fileLines[endLine + offset]) {
        matches = false
        break
      }
      hasContent ||= hasNonWhitespace(line)
    }
    if (matches && hasContent) return count
  }
  return 0
}

function findBoundaryEcho(group: ReplacementGroup, fileLines: readonly string[]): BoundaryEcho | undefined {
  const leadingMax = countDuplicateLeadingBoundaryLines(group, fileLines)
  if (leadingMax === 0) return undefined
  const trailingMax = countDuplicateTrailingBoundaryLines(group, fileLines)
  if (trailingMax === 0) return undefined
  if (leadingMax + trailingMax >= group.payload.length) return undefined
  const leadingBalance = computeDelimiterBalance(group.payload.slice(0, leadingMax))
  const trailingBalance = computeDelimiterBalance(group.payload.slice(group.payload.length - trailingMax))
  const droppedBalance = balanceDelta(leadingBalance, balanceNegate(trailingBalance))
  if (!balanceIsZero(droppedBalance)) {
    const delta = balanceDelta(
      computeDelimiterBalance(group.payload),
      computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine)),
    )
    if (!balanceEqual(droppedBalance, delta)) return undefined
  }
  return { leading: leadingMax, trailing: trailingMax }
}

function describeBoundaryEchoRepair(group: ReplacementGroup, echo: BoundaryEcho): string {
  return `Auto-repaired a replacement boundary echo at line ${group.startLine}: dropped ${echo.leading} leading and ${echo.trailing} trailing payload line(s) already present outside the range. Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`
}

function describeBoundaryRepair(group: ReplacementGroup, action: string): string {
  return `Auto-repaired a delimiter-balance mismatch in the replacement at line ${group.startLine}: ${action}. Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`
}

function findOneSidedBoundaryEcho(
  group: ReplacementGroup,
  fileLines: readonly string[],
): { side: "leading" | "trailing"; count: number } | undefined {
  const leading = countDuplicateLeadingBoundaryLines(group, fileLines)
  const trailing = countDuplicateTrailingBoundaryLines(group, fileLines)
  if (leading > 0 === trailing > 0) return undefined
  const side = leading > 0 ? "leading" : "trailing"
  const count = leading > 0 ? leading : trailing
  if (count >= group.payload.length) return undefined
  const echoLines =
    side === "leading" ? group.payload.slice(0, count) : group.payload.slice(group.payload.length - count)
  if (!balanceIsZero(computeDelimiterBalance(echoLines))) return undefined
  if (group.deleteIndices.length <= 1) {
    if (side !== "trailing" || !echoLines.every(isStructuralCloserLine)) return undefined
    const payloadPrefix = group.payload.slice(0, group.payload.length - count)
    if (payloadHasJsxOpenerForEcho(payloadPrefix, echoLines)) return undefined
  }
  return { side, count }
}

function describeOneSidedEchoRepair(group: ReplacementGroup, side: "leading" | "trailing", count: number): string {
  const where = side === "leading" ? "above" : "below"
  return `Auto-repaired a replacement boundary echo at line ${group.startLine}: dropped ${count} ${side} payload line(s) identical to the surviving line(s) just ${where} the range. The range was one line short of the content you retyped — issue the payload as the final content for the selected range only, and widen the range to consume any keeper you restate.`
}

function repairReplacementBoundaries(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[],
): { edits: AppliedEdit[]; warnings: string[] } {
  const out: AppliedEdit[] = []
  const warnings: string[] = []
  let i = 0
  while (i < edits.length) {
    const group = findReplacementGroup(edits, i)
    if (!group) {
      out.push(edits[i])
      i++
      continue
    }
    const inserts = group.insertIndices.map((idx) => edits[idx])
    const deletes = group.deleteIndices.map((idx) => edits[idx])
    i = group.deleteIndices[group.deleteIndices.length - 1] + 1

    const boundaryEcho = findBoundaryEcho(group, fileLines)
    if (boundaryEcho) {
      warnings.push(describeBoundaryEchoRepair(group, boundaryEcho))
      out.push(...inserts.slice(boundaryEcho.leading, inserts.length - boundaryEcho.trailing), ...deletes)
      continue
    }

    const delta = balanceDelta(
      computeDelimiterBalance(group.payload),
      computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine)),
    )
    if (balanceIsZero(delta)) {
      const oneSided = findOneSidedBoundaryEcho(group, fileLines)
      if (oneSided) {
        warnings.push(describeOneSidedEchoRepair(group, oneSided.side, oneSided.count))
        const trimmed =
          oneSided.side === "leading"
            ? inserts.slice(oneSided.count)
            : inserts.slice(0, inserts.length - oneSided.count)
        out.push(...trimmed, ...deletes)
        continue
      }
      out.push(...inserts, ...deletes)
      continue
    }

    const dupSuffix = findDuplicateSuffix(group, fileLines, delta)
    if (dupSuffix > 0) {
      warnings.push(
        describeBoundaryRepair(
          group,
          `dropped ${dupSuffix} duplicated trailing payload line(s) already present below the range`,
        ),
      )
      out.push(...inserts.slice(0, inserts.length - dupSuffix), ...deletes)
      continue
    }
    const dupPrefix = findDuplicatePrefix(group, fileLines, delta)
    if (dupPrefix > 0) {
      warnings.push(
        describeBoundaryRepair(
          group,
          `dropped ${dupPrefix} duplicated leading payload line(s) already present above the range`,
        ),
      )
      out.push(...inserts.slice(dupPrefix), ...deletes)
      continue
    }
    const droppedClosers = findDroppedSuffixClosers(group, fileLines, delta)
    if (droppedClosers > 0) {
      warnings.push(
        describeBoundaryRepair(
          group,
          `kept ${droppedClosers} structural closing line(s) the range deleted without restating`,
        ),
      )
      out.push(...inserts, ...deletes.slice(0, deletes.length - droppedClosers))
      continue
    }
    out.push(...inserts, ...deletes)
  }
  return { edits: out, warnings }
}

// ── After-insert landing correction ──

function leadingIndent(line: string): string {
  let end = 0
  while (end < line.length) {
    const code = line.charCodeAt(end)
    if (code !== 9 && code !== 32) break
    end++
  }
  return line.slice(0, end)
}

function isIndentDeeper(deeper: string, shallower: string): boolean {
  return deeper.length > shallower.length && deeper.startsWith(shallower)
}

interface AfterInsertGroup {
  anchor: number
  members: number[]
  blockStart?: number
}

function bodyTargetIndent(rows: readonly string[]): string | undefined {
  const nonBlank = rows.filter(hasNonWhitespace)
  if (nonBlank.length === 0) return undefined
  if (nonBlank.every((row) => STRUCTURAL_CLOSER_RE.test(row))) return undefined
  let target = leadingIndent(nonBlank[0] ?? "")
  for (const row of nonBlank) {
    const indent = leadingIndent(row)
    if (indent.startsWith(target)) continue
    if (target.startsWith(indent)) target = indent
    else return undefined
  }
  return target
}

function resolveShiftedLanding(
  group: AfterInsertGroup,
  target: string,
  fileLines: readonly string[],
  targetedLines: ReadonlySet<number>,
): { line: number; crossed: number } | undefined {
  const anchorText = fileLines[group.anchor - 1]
  if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined
  if (!isIndentDeeper(leadingIndent(anchorText), target)) return undefined
  let landing = group.anchor
  let crossed = 0
  for (let line = group.anchor + 1; line <= fileLines.length; line++) {
    const text = fileLines[line - 1] ?? ""
    if (!hasNonWhitespace(text)) continue
    if (!STRUCTURAL_CLOSER_RE.test(text)) break
    const indent = leadingIndent(text)
    if (!indent.startsWith(target)) break
    if (targetedLines.has(line)) return undefined
    landing = line
    crossed++
    if (indent.length === target.length) break
  }
  return landing === group.anchor ? undefined : { line: landing, crossed }
}

function resolveInwardLanding(
  group: AfterInsertGroup,
  target: string,
  blockStart: number,
  fileLines: readonly string[],
  targetedLines: ReadonlySet<number>,
): number | undefined {
  const anchorText = fileLines[group.anchor - 1]
  if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined
  if (!STRUCTURAL_CLOSER_RE.test(anchorText)) return undefined
  if (!isIndentDeeper(target, leadingIndent(anchorText))) return undefined
  let landing = group.anchor
  for (let line = group.anchor; line > blockStart; line--) {
    const text = fileLines[line - 1] ?? ""
    if (!hasNonWhitespace(text)) {
      landing = line - 1
      continue
    }
    if (!STRUCTURAL_CLOSER_RE.test(text)) break
    const indent = leadingIndent(text)
    if (!isIndentDeeper(target, indent)) break
    if (line !== group.anchor && targetedLines.has(line)) return undefined
    landing = line - 1
  }
  return landing === group.anchor ? undefined : landing
}

function repairAfterInsertLandings(
  edits: readonly AppliedEdit[],
  fileLines: readonly string[],
): { edits: readonly AppliedEdit[]; warnings: string[] } {
  const groups = new Map<string, AfterInsertGroup>()
  edits.forEach((edit, idx) => {
    if (edit.kind !== "insert" || edit.mode === "replacement") return
    if (edit.cursor.kind !== "after_anchor") return
    const key = `${edit.cursor.anchor.line}:${edit.lineNum}`
    const group = groups.get(key)
    if (group === undefined)
      groups.set(key, { anchor: edit.cursor.anchor.line, members: [idx], blockStart: edit.blockStart })
    else group.members.push(idx)
  })
  if (groups.size === 0) return { edits, warnings: [] }

  const targetedLines = new Set<number>()
  for (const edit of edits) {
    if (edit.kind === "delete") targetedLines.add(edit.anchor.line)
    else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor")
      targetedLines.add(edit.cursor.anchor.line)
  }

  let out: AppliedEdit[] | undefined
  const warnings: string[] = []
  const retarget = (group: AfterInsertGroup, line: number): void => {
    out ??= [...edits]
    for (const idx of group.members) {
      const edit = out[idx] as InsertEdit
      out[idx] = { ...edit, cursor: { kind: "after_anchor", anchor: { line } } }
    }
  }
  for (const group of groups.values()) {
    const target = bodyTargetIndent(group.members.map((idx) => (edits[idx] as InsertEdit).text))
    if (target === undefined) continue
    const outward = resolveShiftedLanding(group, target, fileLines, targetedLines)
    if (outward !== undefined) {
      retarget(group, outward.line)
      warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.line, outward.crossed))
      continue
    }
    if (group.blockStart === undefined) continue
    const inward = resolveInwardLanding(group, target, group.blockStart, fileLines, targetedLines)
    if (inward === undefined) continue
    retarget(group, inward)
    warnings.push(blockInsertLandingShiftWarning(group.blockStart, group.anchor, inward))
  }
  return { edits: out ?? edits, warnings }
}

/** Apply a parsed list of edits to a text body. Pure function — no I/O. */
export function applyEdits(text: string, edits: readonly Edit[]): ApplyResult {
  if (edits.length === 0) return { text, firstChangedLine: undefined }

  for (const edit of edits) {
    if (edit.kind === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL)
  }
  const appliedEdits = edits as readonly AppliedEdit[]

  const fileLines = text.split("\n")
  const lineOrigins: LineOrigin[] = fileLines.map(() => "original")

  let firstChangedLine: number | undefined
  const trackFirstChanged = (line: number) => {
    if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line
  }

  const targetEdits = dropTrailingPhantomDeletes(
    appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index)),
    fileLines,
  )
  validateLineBounds(targetEdits, fileLines)
  const { edits: repaired, warnings: boundaryWarnings } = repairReplacementBoundaries(targetEdits, fileLines)
  const { edits: landed, warnings: landingWarnings } = repairAfterInsertLandings(repaired, fileLines)
  const warnings = [...boundaryWarnings, ...landingWarnings]

  const bofLines: string[] = []
  const eofLines: string[] = []
  const anchorEdits: IndexedEdit[] = []
  landed.forEach((edit, idx) => {
    if (edit.kind === "insert" && edit.cursor.kind === "bof") bofLines.push(edit.text)
    else if (edit.kind === "insert" && edit.cursor.kind === "eof") eofLines.push(edit.text)
    else anchorEdits.push({ edit, idx })
  })

  const byLine = bucketAnchorEditsByLine(anchorEdits)
  for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
    const bucket = byLine.get(line)
    if (!bucket) continue
    bucket.sort((a, b) => a.idx - b.idx)
    const idx = line - 1
    const currentLine = fileLines[idx] ?? ""
    const beforeInsertLines: string[] = []
    const afterInsertLines: string[] = []
    const replacementLines: string[] = []
    let deleteLine = false
    for (const { edit } of bucket) {
      if (isReplacementInsert(edit)) replacementLines.push(edit.text)
      else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") afterInsertLines.push(edit.text)
      else if (edit.kind === "insert") beforeInsertLines.push(edit.text)
      else if (edit.kind === "delete") deleteLine = true
    }
    if (beforeInsertLines.length === 0 && replacementLines.length === 0 && afterInsertLines.length === 0 && !deleteLine)
      continue

    const replacement = deleteLine
      ? [...beforeInsertLines, ...replacementLines, ...afterInsertLines]
      : [...beforeInsertLines, ...replacementLines, currentLine, ...afterInsertLines]
    const origins: LineOrigin[] = []
    for (let i = 0; i < beforeInsertLines.length; i++) origins.push("insert")
    for (let i = 0; i < replacementLines.length; i++) origins.push(deleteLine ? "replacement" : "insert")
    if (!deleteLine) origins.push(lineOrigins[idx] ?? "original")
    for (let i = 0; i < afterInsertLines.length; i++) origins.push("insert")
    fileLines.splice(idx, 1, ...replacement)
    lineOrigins.splice(idx, 1, ...origins)
    trackFirstChanged(line)
  }

  if (bofLines.length > 0) {
    insertAtStart(fileLines, lineOrigins, bofLines)
    trackFirstChanged(1)
  }
  const eofChangedLine = insertAtEnd(fileLines, lineOrigins, eofLines)
  if (eofChangedLine !== undefined) trackFirstChanged(eofChangedLine)

  return { text: fileLines.join("\n"), firstChangedLine, ...(warnings.length > 0 ? { warnings } : {}) }
}

/**
 * Token-driven state machine that turns a stream of Tokens into a flat list of Edits.
 * Sits between the Tokenizer and the applier.
 */
import { HL_PAYLOAD_REPLACE, HL_RANGE_SEP } from "./format"
import {
  BARE_BODY_AUTO_PIPED_WARNING,
  DELETE_BLOCK_TAKES_NO_BODY,
  DELETE_TAKES_NO_BODY,
  EMPTY_BLOCK,
  EMPTY_INSERT,
  MINUS_ROW_REJECTED,
} from "./messages"
import { stripOneLeadingHashlinePrefix } from "./prefixes"
import { type BlockTarget, cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer"
import type { Anchor, Cursor, Edit } from "./types"

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
  if (range.end.line < range.start.line) {
    throw new Error(`line ${lineNum}: range ${range.start.line}${HL_RANGE_SEP}${range.end.line} ends before it starts.`)
  }
}

function expandRange(range: ParsedRange): Anchor[] {
  const anchors: Anchor[] = []
  for (let line = range.start.line; line <= range.end.line; line++) anchors.push({ line })
  return anchors
}

function isSkippableCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#")
}

const BARE_LITERAL_VALUE_RE = /^\s*(?:"[^"]*"|'[^']*'|[-+]?\d+(?:\.\d+)?)\s*,?\s*$/

function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
  const trimmed = text.trimStart()
  if (trimmed.length === 0) return null
  if (
    trimmed.startsWith("*** Update File:") ||
    trimmed.startsWith("*** Add File:") ||
    trimmed.startsWith("*** Delete File:") ||
    trimmed.startsWith("*** Move to:")
  ) {
    const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed
    return (
      `apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
      "File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). " +
      `Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
    )
  }
  if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
    return (
      "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
      `Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
    )
  }
  if (trimmed.startsWith("@@")) {
    const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed
    return (
      `\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
      `Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N${HL_RANGE_SEP}M:\`.`
    )
  }
  if (/^DEL\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*:/.test(trimmed)) {
    return `\`DEL N${HL_RANGE_SEP}M\` has no colon and no body. Remove the colon and body rows.`
  }
  if (/^[1-9]\d*\s*$/.test(trimmed)) {
    return `hunk headers need a verb. Use \`SWAP ${trimmed}${HL_RANGE_SEP}${trimmed}:\` to replace, or \`DEL ${trimmed}\` to delete.`
  }
  const bareRange = /^([1-9]\d*)\s*[-. …=]+\s*([1-9]\d*)\s*:?$/.exec(trimmed)
  if (bareRange !== null) {
    return (
      `bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
      `Hunk headers need a verb: write \`SWAP ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}:\` or \`DEL ${bareRange[1]}${HL_RANGE_SEP}${bareRange[2]}\`.`
    )
  }
  return null
}

interface PendingComment {
  lineNum: number
  text: string
}

type PayloadRow = { kind: "literal"; text: string; lineNum: number; bare?: boolean }

interface Pending {
  target: BlockTarget
  lineNum: number
  payloads: PayloadRow[]
  deferredBlanks: PayloadRow[]
}

export class Executor {
  #edits: Edit[] = []
  #warnings: string[] = []
  #editIndex = 0
  #pending: Pending | undefined
  #terminated = false
  #skippableComments: PendingComment[] = []

  #discardPendingSkippableComments(): void {
    this.#skippableComments = []
  }
  #consumePendingSkippableComments(): void {
    if (this.#skippableComments.length === 0) return
    for (const comment of this.#skippableComments) this.#handleRaw(comment.text, comment.lineNum)
    this.#skippableComments = []
  }

  feed(token: Token): void {
    if (this.#terminated) return
    switch (token.kind) {
      case "envelope-begin":
        this.#consumePendingSkippableComments()
        return
      case "envelope-end":
        this.#consumePendingSkippableComments()
        this.#terminated = true
        return
      case "abort":
        this.#terminated = true
        return
      case "header":
        this.#consumePendingSkippableComments()
        this.#flushPending()
        return
      case "blank":
        this.#consumePendingSkippableComments()
        this.#handleBlank("", token.lineNum)
        return
      case "payload-literal":
        this.#consumePendingSkippableComments()
        this.#handleLiteralPayload(token.text, token.lineNum)
        return
      case "raw":
        if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
          this.#skippableComments.push({ text: token.text, lineNum: token.lineNum })
          return
        }
        this.#consumePendingSkippableComments()
        this.#handleRaw(token.text, token.lineNum)
        return
      case "op-block":
        this.#discardPendingSkippableComments()
        if (token.target.kind === "replace" || token.target.kind === "delete")
          validateRangeOrder(token.target.range, token.lineNum)
        this.#flushPending()
        this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [], deferredBlanks: [] }
        return
    }
  }

  end(): { edits: Edit[]; warnings: string[] } {
    this.#consumePendingSkippableComments()
    this.#flushPending()
    this.#validateNoOverlappingDeletes()
    return { edits: this.#edits, warnings: this.#warnings }
  }

  endStreaming(): { edits: Edit[]; warnings: string[] } {
    this.#consumePendingSkippableComments()
    if (this.#pending && this.#pending.payloads.length > 0) this.#flushPending()
    else if (this.#pending?.target.kind === "delete" || this.#pending?.target.kind === "delete_block")
      this.#flushPending()
    else this.#pending = undefined
    this.#validateNoOverlappingDeletes()
    return { edits: this.#edits, warnings: this.#warnings }
  }

  reset(): void {
    this.#edits = []
    this.#warnings = []
    this.#editIndex = 0
    this.#pending = undefined
    this.#skippableComments = []
    this.#terminated = false
  }

  #validateNoOverlappingDeletes(): void {
    const sourceLinesByAnchor = new Map<number, number[]>()
    for (const edit of this.#edits) {
      if (edit.kind !== "delete") continue
      let sourceLines = sourceLinesByAnchor.get(edit.anchor.line)
      if (sourceLines === undefined) {
        sourceLines = []
        sourceLinesByAnchor.set(edit.anchor.line, sourceLines)
      }
      if (!sourceLines.includes(edit.lineNum)) sourceLines.push(edit.lineNum)
    }
    for (const [anchorLine, sourceLines] of sourceLinesByAnchor) {
      if (sourceLines.length < 2) continue
      const [firstBlock, secondBlock] = [...sourceLines].sort((a, b) => a - b)
      throw new Error(
        `line ${secondBlock}: anchor line ${anchorLine} is already targeted by another hunk on line ${firstBlock}. ` +
          "Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
      )
    }
  }

  #handleLiteralPayload(text: string, lineNum: number): void {
    const pending = this.#pending
    if (!pending)
      throw new Error(
        `line ${lineNum}: payload line has no preceding hunk header. Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
      )
    if (pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY}`)
    if (pending.target.kind === "delete_block") throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY}`)
    this.#commitDeferredBlanks(pending)
    pending.payloads.push({ kind: "literal", text, lineNum })
  }

  #handleRaw(text: string, lineNum: number): void {
    const contamination = detectApplyPatchContamination(text, this.#pending !== undefined)
    if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`)
    if (this.#pending) {
      if (text.trim().length === 0) {
        this.#handleBlank(text, lineNum)
        return
      }
      if (this.#pending.target.kind === "delete") throw new Error(`line ${lineNum}: ${DELETE_TAKES_NO_BODY}`)
      if (this.#pending.target.kind === "delete_block")
        throw new Error(`line ${lineNum}: ${DELETE_BLOCK_TAKES_NO_BODY}`)
      if (text.trimStart().charCodeAt(0) === 45 /* - */) throw new Error(`line ${lineNum}: ${MINUS_ROW_REJECTED}`)
      if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING)
      this.#commitDeferredBlanks(this.#pending)
      this.#pending.payloads.push({ kind: "literal", text, lineNum, bare: true })
      return
    }
    if (text.trim().length === 0) return
    throw new Error(
      `line ${lineNum}: payload line has no preceding hunk header. ` +
        `Use \`SWAP N${HL_RANGE_SEP}M:\`, \`DEL N${HL_RANGE_SEP}M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got ${JSON.stringify(text)}.`,
    )
  }

  #handleBlank(_text: string, lineNum: number): void {
    const pending = this.#pending
    if (!pending) return
    if (pending.target.kind === "delete" || pending.target.kind === "delete_block") return
    if (pending.payloads.length === 0) return
    pending.deferredBlanks.push({ kind: "literal", text: "", lineNum, bare: true })
  }

  #commitDeferredBlanks(pending: Pending): void {
    if (pending.deferredBlanks.length === 0) return
    if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING)
    pending.payloads.push(...pending.deferredBlanks)
    pending.deferredBlanks = []
  }

  #stripBarePrefixesIfUniform(payloads: PayloadRow[]): void {
    let sawBare = false
    let allLiteralValues = true
    for (const row of payloads) {
      if (!row.bare || row.text.trim().length === 0) continue
      sawBare = true
      const stripped = stripOneLeadingHashlinePrefix(row.text)
      if (stripped === row.text) return
      allLiteralValues &&= BARE_LITERAL_VALUE_RE.test(stripped)
    }
    if (!sawBare) return
    if (allLiteralValues) return
    for (const row of payloads) {
      if (row.bare && row.text.trim().length > 0) row.text = stripOneLeadingHashlinePrefix(row.text)
    }
  }

  #pushInsert(cursor: Cursor, text: string, lineNum: number, mode?: "replacement"): void {
    this.#edits.push({
      kind: "insert",
      cursor: cloneCursor(cursor),
      text,
      lineNum,
      index: this.#editIndex++,
      ...(mode === undefined ? {} : { mode }),
    })
  }

  #pushDelete(anchor: Anchor, lineNum: number): void {
    this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ })
  }

  #pushBlock(anchor: Anchor, payloads: readonly PayloadRow[], lineNum: number, mode?: "insert_after"): void {
    this.#edits.push({
      kind: "block",
      anchor: { ...anchor },
      payloads: payloads.map((p) => p.text),
      ...(mode === undefined ? {} : { mode }),
      lineNum,
      index: this.#editIndex++,
    })
  }

  #emitPayloadRows(cursor: Cursor, payloads: readonly PayloadRow[], lineNum: number, mode?: "replacement"): void {
    for (const payload of payloads) this.#pushInsert(cursor, payload.text, lineNum, mode)
  }

  #flushPending(): void {
    const pending = this.#pending
    if (!pending) return
    const { target, lineNum, payloads } = pending
    this.#stripBarePrefixesIfUniform(payloads)
    this.#pending = undefined
    if (target.kind === "delete") {
      for (const anchor of expandRange(target.range)) this.#pushDelete(anchor, lineNum)
      return
    }
    if (target.kind === "delete_block") {
      this.#pushBlock(target.anchor, [], lineNum)
      return
    }
    if (target.kind === "block") {
      if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_BLOCK}`)
      this.#pushBlock(target.anchor, payloads, lineNum)
      return
    }
    if (target.kind === "insert_after_block") {
      if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_INSERT}`)
      this.#pushBlock(target.anchor, payloads, lineNum, "insert_after")
      return
    }
    if (payloads.length === 0) {
      if (target.kind === "replace") {
        for (const anchor of expandRange(target.range)) this.#pushDelete(anchor, lineNum)
        return
      }
      throw new Error(`line ${lineNum}: ${EMPTY_INSERT}`)
    }
    if (target.kind === "replace") {
      const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } }
      this.#emitPayloadRows(cursor, payloads, lineNum, "replacement")
      for (const anchor of expandRange(target.range)) this.#pushDelete(anchor, lineNum)
      return
    }
    if (target.kind === "insert_before") {
      this.#emitPayloadRows({ kind: "before_anchor", anchor: { ...target.anchor } }, payloads, lineNum)
      return
    }
    if (target.kind === "insert_after") {
      this.#emitPayloadRows({ kind: "after_anchor", anchor: { ...target.anchor } }, payloads, lineNum)
      return
    }
    const cursor: Cursor = target.kind === "bof" ? { kind: "bof" } : { kind: "eof" }
    this.#emitPayloadRows(cursor, payloads, lineNum)
  }
}

function drain(executor: Executor, tokenizer: Tokenizer): { edits: Edit[]; warnings: string[] } {
  for (const token of tokenizer.end()) executor.feed(token)
  return executor.end()
}

export function parsePatch(diff: string): { edits: Edit[]; warnings: string[] } {
  const tokenizer = new Tokenizer()
  const executor = new Executor()
  for (const token of tokenizer.feed(diff)) executor.feed(token)
  return drain(executor, tokenizer)
}

export function parsePatchStreaming(diff: string): { edits: Edit[]; warnings: string[] } {
  const tokenizer = new Tokenizer()
  const executor = new Executor()
  for (const token of tokenizer.feed(diff)) executor.feed(token)
  for (const token of tokenizer.end()) executor.feed(token)
  return executor.endStreaming()
}

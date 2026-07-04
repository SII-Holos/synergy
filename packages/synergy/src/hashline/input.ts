/**
 * Top-level patch parser. Splits authored hashline input into a list of
 * PatchSections, each rooted at a `[PATH#HASH]` header.
 */
import * as path from "node:path"
import { applyEdits } from "./apply"
import { resolveBlockEdits } from "./block"
import { HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format"
import { parsePatch, parsePatchStreaming } from "./parser"
import { Tokenizer } from "./tokenizer"
import type { ApplyResult, BlockResolver, Edit, SplitOptions } from "./types"
import { isPathContained } from "../util/path-contain"

const TOKENIZER = new Tokenizer()

function unquoteHashlinePath(pathText: string): string {
  if (pathText.length < 2) return pathText
  const first = pathText[0]
  const last = pathText[pathText.length - 1]
  if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1)
  return pathText
}

const APPLY_PATCH_PATH_NOISE_RE =
  /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i

function stripApplyPatchPathNoise(pathText: string): string {
  return pathText.replace(APPLY_PATCH_PATH_NOISE_RE, "")
}

function tryParseRecoveryHeader(line: string, cwd?: string): RawSection | null {
  if (!line.startsWith(HL_FILE_PREFIX) || !line.endsWith(HL_FILE_SUFFIX)) return null
  const body = stripApplyPatchPathNoise(line.slice(HL_FILE_PREFIX.length, line.length - HL_FILE_SUFFIX.length).trim())
  if (body.length === 0) return null
  const trailing = new RegExp(`#([0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}})\\s*$`).exec(body)
  let pathText: string
  let fileHash: string | undefined
  if (trailing !== null) {
    pathText = body.slice(0, trailing.index)
    fileHash = trailing[1].toUpperCase()
  } else pathText = body.replace(/\s+$/, "")
  if (pathText.includes("#")) return null
  const normalizedPath = normalizeHashlinePath(pathText, cwd)
  if (normalizedPath.length === 0) return null
  return fileHash !== undefined ? { path: normalizedPath, fileHash, diff: "" } : { path: normalizedPath, diff: "" }
}

function normalizeHashlinePath(rawPath: string, cwd?: string): string {
  const unquoted = stripApplyPatchPathNoise(unquoteHashlinePath(rawPath.trim()))
  if (!cwd || !path.isAbsolute(unquoted)) return unquoted
  const relative = path.relative(path.resolve(cwd), path.resolve(unquoted))
  const normalizedRelative = relative.split(path.sep).join("/")
  return isPathContained(cwd, unquoted) ? normalizedRelative || "." : unquoted
}

interface RawSection {
  path: string
  fileHash?: string
  diff: string
}

function parseHashlineHeaderLine(line: string, cwd?: string): RawSection | null {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith(HL_FILE_PREFIX)) return null
  const token = TOKENIZER.tokenize(trimmed)
  if (token.kind !== "header") {
    const recovered = tryParseRecoveryHeader(trimmed, cwd)
    if (recovered !== null) return recovered
    throw new Error(
      `Input header must be ${HL_FILE_PREFIX}PATH${HL_FILE_SUFFIX} or ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX} with a ${HL_FILE_HASH_LENGTH}-hex content-hash tag; got ${JSON.stringify(trimmed)}.`,
    )
  }
  const parsedPath = normalizeHashlinePath(token.path, cwd)
  if (parsedPath.length === 0)
    throw new Error(`Input header "${HL_FILE_PREFIX}${HL_FILE_SUFFIX}" is empty; provide a file path.`)
  return token.fileHash !== undefined
    ? { path: parsedPath, fileHash: token.fileHash, diff: "" }
    : { path: parsedPath, diff: "" }
}

function stripLeadingBlankLines(input: string): string {
  const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input
  const lines = stripped.split("\n")
  while (lines.length > 0) {
    const head = lines[0].replace(/\r$/, "")
    if (head.trim().length === 0 || TOKENIZER.tokenize(head).kind === "envelope-begin") {
      lines.shift()
      continue
    }
    break
  }
  return lines.join("\n")
}

export function containsRecognizableHashlineOperations(input: string): boolean {
  for (const line of input.split(/\r?\n/)) {
    if (TOKENIZER.isOp(line)) return true
  }
  return false
}

function normalizeFallbackInput(input: string, options: SplitOptions): string {
  const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input
  const hasExplicitHeader = stripped
    .split(/\r?\n/)
    .some((rawLine) => parseHashlineHeaderLine(rawLine, options.cwd) !== null)
  if (hasExplicitHeader) return input
  if (!options.path || !containsRecognizableHashlineOperations(input)) return input
  const fallbackPath = normalizeHashlinePath(options.path, options.cwd)
  if (fallbackPath.length === 0) return input
  return `${HL_FILE_PREFIX}${fallbackPath}${HL_FILE_SUFFIX}\n${input}`
}

function splitRawSections(input: string, options: SplitOptions = {}): RawSection[] {
  const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options))
  const lines = stripped.split(/\r?\n/)
  const firstLine = lines[0] ?? ""

  if (parseHashlineHeaderLine(firstLine, options.cwd) === null) {
    const firstTrimmed = firstLine.trimEnd()
    if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(firstTrimmed)) {
      throw new Error(
        "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
          `File sections start with \`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}HASH${HL_FILE_SUFFIX}\`; use \`replace\`, \`delete\`, or \`insert\` ops.`,
      )
    }
    const preview = JSON.stringify(firstLine.slice(0, 120))
    throw new Error(
      `input must begin with "${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}HASH${HL_FILE_SUFFIX}" on the first non-blank line for anchored edits; got: ${preview}. ` +
        `Example: "${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}${HL_FILE_HASH_EXAMPLES[0]}${HL_FILE_SUFFIX}" then edit ops.`,
    )
  }

  const sections: RawSection[] = []
  let current: RawSection | undefined
  let currentLines: string[] = []

  const flush = () => {
    if (!current) return
    const hasOps = currentLines.some((line) => line.trim().length > 0)
    if (hasOps) sections.push({ ...current, diff: currentLines.join("\n") })
    currentLines = []
  }

  for (const line of lines) {
    const trimmed = line.trimEnd()
    const token = TOKENIZER.tokenize(line)
    if (token.kind === "envelope-end" || token.kind === "abort") break
    if (token.kind === "envelope-begin") continue
    if (trimmed.startsWith(HL_FILE_PREFIX)) {
      const header = parseHashlineHeaderLine(line, options.cwd)
      if (header !== null) {
        flush()
        current = header
        currentLines = []
        continue
      }
    }
    currentLines.push(line)
  }
  flush()
  return sections
}

export class PatchSection {
  readonly path: string
  readonly fileHash: string | undefined
  readonly diff: string
  #parsed: { edits: Edit[]; warnings: string[] } | undefined

  constructor(raw: RawSection) {
    this.path = raw.path
    this.fileHash = raw.fileHash
    this.diff = raw.diff
  }

  parse(): { edits: Edit[]; warnings: readonly string[] } {
    this.#parsed ??= parsePatch(this.diff)
    return this.#parsed
  }

  get edits(): readonly Edit[] {
    return this.parse().edits
  }
  get warnings(): readonly string[] {
    return this.parse().warnings
  }

  get hasAnchorScopedEdit(): boolean {
    return this.edits.some((edit) => {
      if (edit.kind === "delete") return true
      if (edit.kind === "block") return true
      return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor"
    })
  }

  collectAnchorLines(): readonly number[] {
    const lines = new Set<number>()
    for (const edit of this.edits) {
      if (edit.kind === "delete") {
        lines.add(edit.anchor.line)
        continue
      }
      if (edit.kind === "block") {
        lines.add(edit.anchor.line)
        continue
      }
      if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor")
        lines.add(edit.cursor.anchor.line)
    }
    return [...lines].sort((a, b) => a - b)
  }

  applyTo(text: string, blockResolver?: BlockResolver): ApplyResult {
    const { edits, warnings } = this.parse()
    const resolveWarnings: string[] = []
    const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
      onUnresolved: "throw",
      onWarning: (warning) => resolveWarnings.push(warning),
    })
    const result = applyEdits(text, resolved)
    const merged = [...warnings, ...resolveWarnings, ...(result.warnings ?? [])]
    return merged.length > 0
      ? { ...result, warnings: merged }
      : { text: result.text, firstChangedLine: result.firstChangedLine }
  }

  applyPartialTo(text: string, blockResolver?: BlockResolver): ApplyResult {
    const { edits, warnings } = parsePatchStreaming(this.diff)
    const resolveWarnings: string[] = []
    const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
      onUnresolved: "drop",
      onWarning: (warning) => resolveWarnings.push(warning),
    })
    const result = applyEdits(text, resolved)
    const merged = [...warnings, ...resolveWarnings, ...(result.warnings ?? [])]
    return merged.length > 0
      ? { ...result, warnings: merged }
      : { text: result.text, firstChangedLine: result.firstChangedLine }
  }
}

export class Patch {
  readonly sections: readonly PatchSection[]

  private constructor(sections: PatchSection[]) {
    this.sections = sections
  }

  static parse(input: string, options: SplitOptions = {}): Patch {
    const raw = mergeSamePathSections(splitRawSections(input, options))
    return new Patch(raw.map((section) => new PatchSection(section)))
  }

  static parseSingle(input: string, options: SplitOptions = {}): PatchSection {
    const patch = Patch.parse(input, options)
    const first = patch.sections[0]
    if (!first) throw new Error("Patch input did not produce any sections.")
    return first
  }
}

function mergeSamePathSections(sections: RawSection[]): RawSection[] {
  const byPath = new Map<string, { fileHash?: string; diffs: string[] }>()
  for (const section of sections) {
    const existing = byPath.get(section.path)
    if (existing) {
      if (existing.fileHash !== undefined && section.fileHash !== undefined && existing.fileHash !== section.fileHash) {
        throw new Error(
          `Conflicting hashline snapshot tags for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
        )
      }
      if (existing.fileHash === undefined && section.fileHash !== undefined) existing.fileHash = section.fileHash
      existing.diffs.push(section.diff)
      continue
    }
    byPath.set(section.path, {
      ...(section.fileHash !== undefined ? { fileHash: section.fileHash } : {}),
      diffs: [section.diff],
    })
  }
  return Array.from(byPath, ([sectionPath, entry]) => ({
    path: sectionPath,
    ...(entry.fileHash !== undefined ? { fileHash: entry.fileHash } : {}),
    diff: entry.diffs.join("\n"),
  }))
}

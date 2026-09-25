/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 *
 * Merged from OMP format.ts + existing Synergy format.ts. Backward compat
 * exports preserved for the tool bridge.
 */

import type { Cursor } from "./types"

/** File-section header delimiters: `[path#hash]`. */
export const HL_FILE_PREFIX = "["
export const HL_FILE_SUFFIX = "]"

/** Payload sigil for literal body rows. */
export const HL_PAYLOAD_REPLACE = "+"

/** Hunk-header keyword for concrete line replacement. */
export const HL_REPLACE_KEYWORD = "SWAP"
/** Hunk-header keyword for concrete line deletion. */
export const HL_DELETE_KEYWORD = "DEL"
/** Hunk-header keyword for insertion operations. */
export const HL_INSERT_KEYWORD = "INS"
/** Insert position keyword for inserting before a concrete line. */
export const HL_INSERT_BEFORE = "PRE"
/** Insert position keyword for inserting after a concrete line. */
export const HL_INSERT_AFTER = "POST"
/** Insert position keyword for inserting at the start of the file. */
export const HL_INSERT_HEAD = "HEAD"
/** Insert position keyword for inserting at the end of the file. */
export const HL_INSERT_TAIL = "TAIL"
/** Hunk-header keyword: `SWAP.BLK N:` resolves N to a tree-sitter block range. */
export const HL_REPLACE_BLOCK_KEYWORD = "SWAP.BLK"
/** Hunk-header keyword: `DEL.BLK N` resolves N to a tree-sitter block range. */
export const HL_DELETE_BLOCK_KEYWORD = "DEL.BLK"
/** Hunk-header keyword: `INS.BLK.POST N:` inserts after the last line of the tree-sitter block at N. */
export const HL_INSERT_AFTER_BLOCK_KEYWORD = "INS.BLK.POST"
// ── Legacy (pre-OMP) keyword aliases, recognized alongside OMP forms ──
export const HL_LEGACY_REPLACE_KEYWORD = "replace"
export const HL_LEGACY_DELETE_KEYWORD = "delete"
export const HL_LEGACY_INSERT_KEYWORD = "insert"
export const HL_HEADER_COLON = ":"

/** Separator between a hashline file path and its opaque snapshot tag. */
export const HL_FILE_HASH_SEP = "#"

/** Separator between two line numbers in a range, e.g. `5.=10`. */
export const HL_RANGE_SEP = ".="

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":"

function regexEscape(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export const HL_LINE_RE_RAW = `[1-9]\\d*`

/** Capture-group form of `HL_LINE_RE_RAW`. */
export const HL_LINE_CAPTURE_RE_RAW = `(${HL_LINE_RE_RAW})`

/** Format a concrete replacement hunk header. */
export function formatReplaceHeader(start: number, end: number): string {
  return `${HL_REPLACE_KEYWORD} ${start}${HL_RANGE_SEP}${end}${HL_HEADER_COLON}`
}

/** Format a concrete deletion hunk header. */
export function formatDeleteHeader(start: number, end = start): string {
  return start === end ? `${HL_DELETE_KEYWORD} ${start}` : `${HL_DELETE_KEYWORD} ${start}${HL_RANGE_SEP}${end}`
}

/** Format an insertion hunk header for a cursor position. */
export function formatInsertHeader(cursor: Cursor): string {
  switch (cursor.kind) {
    case "before_anchor":
      return `${HL_INSERT_KEYWORD}.${HL_INSERT_BEFORE} ${cursor.anchor.line}${HL_HEADER_COLON}`
    case "after_anchor":
      return `${HL_INSERT_KEYWORD}.${HL_INSERT_AFTER} ${cursor.anchor.line}${HL_HEADER_COLON}`
    case "bof":
      return `${HL_INSERT_KEYWORD}.${HL_INSERT_HEAD}${HL_HEADER_COLON}`
    case "eof":
      return `${HL_INSERT_KEYWORD}.${HL_INSERT_TAIL}${HL_HEADER_COLON}`
  }
}

/** Number of hex characters in a content-derived file-hash tag. */
export const HL_FILE_HASH_LENGTH = 4
/** Canonical uppercase hexadecimal content-hash tag. */
export const HL_FILE_HASH_RE_RAW = `[0-9A-F]{${HL_FILE_HASH_LENGTH}}`
/** Capture-group form of `HL_FILE_HASH_RE_RAW`. */
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`
/** Regex-escaped form of `HL_LINE_BODY_SEP`. */
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP)
/** Representative file-hash tags for error messages and prompt examples. */
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const

function normalizeFileHashText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+(?=\n|$)/g, "")
}

/**
 * Compute the content-derived hash tag carried by a hashline section header.
 * The tag is a 4-hex fingerprint of the whole file's normalized text.
 */
export function computeFileHash(text: string): string {
  const normalized = normalizeFileHashText(text)
  const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff
  return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase()
}

/** Format a comma-separated list of example anchors, quoted for error messages. */
export function describeAnchorExamples(linePrefix = ""): string {
  const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"]
  return examples.map((e) => `"${e}"`).join(", ")
}

/** Format a hashline section header for a file path and snapshot tag. */
export function formatHashlineHeader(filePath: string, fileHash: string): string {
  return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`
}

/** Formats a single numbered line as `LINE:TEXT`. */
export function formatNumberedLine(lineNumber: number, line: string): string {
  return `${lineNumber}${HL_LINE_BODY_SEP}${line}`
}

/** Format file text with hashline-mode line-number prefixes for display. */
export function formatNumberedLines(text: string, startLine = 1): string {
  const lines = text.split("\n")
  return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n")
}

// ── Backward-compat exports (Synergy tool bridge) ──

/** Format a hashline block for writing (backward compat). */
export function formatHashlineBlock(filePath: string, tag: string, content: string): string {
  const header = formatHashlineHeader(filePath, tag)
  const body = formatNumberedLines(content)
  return body ? `${header}\n${body}` : `${header}\n`
}

/**
 * Strip hashline display prefixes from content (backward compat).
 * Also exported as `stripHashlineDisplayPrefixes`.
 */
export function stripHashlineDisplayPrefixes(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  const lines = normalized.split("\n")
  if (!lines[0]?.match(/^\[[^\]\n#]+#[0-9A-F]{4}\]$/)) return content

  const hasTrailingNewline = lines.length > 1 && lines.at(-1) === ""
  const body = hasTrailingNewline ? lines.slice(1, -1) : lines.slice(1)
  const displayLinePattern = /^(\d+):(.*)$/
  const numbered = body.map((line) => line.match(displayLinePattern))
  if (numbered.some((match) => !match)) return content
  if (numbered.some((match, index) => Number(match?.[1]) !== index + 1)) return content
  return numbered.map((match) => match?.[2] ?? "").join("\n") + (hasTrailingNewline ? "\n" : "")
}

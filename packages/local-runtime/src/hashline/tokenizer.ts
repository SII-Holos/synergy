/**
 * Stateful, line-oriented classifier for hashline diff text.
 * Recognizes both OMP (SWAP/DEL/INS.*) and legacy (replace/delete/insert before/after/head/tail) verb forms.
 * Internally both are unified to the same BlockTarget types.
 */
import {
  describeAnchorExamples,
  HL_DELETE_BLOCK_KEYWORD,
  HL_DELETE_KEYWORD,
  HL_FILE_HASH_LENGTH,
  HL_FILE_HASH_SEP,
  HL_FILE_PREFIX,
  HL_FILE_SUFFIX,
  HL_HEADER_COLON,
  HL_INSERT_AFTER,
  HL_INSERT_AFTER_BLOCK_KEYWORD,
  HL_INSERT_BEFORE,
  HL_INSERT_HEAD,
  HL_INSERT_KEYWORD,
  HL_INSERT_TAIL,
  HL_LEGACY_DELETE_KEYWORD,
  HL_LEGACY_INSERT_KEYWORD,
  HL_LEGACY_REPLACE_KEYWORD,
  HL_PAYLOAD_REPLACE,
  HL_REPLACE_BLOCK_KEYWORD,
  HL_REPLACE_KEYWORD,
} from "./format"
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./messages"
import type { Anchor, Cursor, ParsedRange } from "./types"

const CHAR_LINE_FEED = 10
const CHAR_CARRIAGE_RETURN = 13
const CHAR_ZERO = 48
const CHAR_NINE = 57
const CHAR_HASH = 35
const CHAR_TAB = 9
const CHAR_SPACE = 32
const CHAR_DOT = 46
const CHAR_HYPHEN = 45
const CHAR_ELLIPSIS = 0x2026
const CHAR_EQUALS = 61

const CHAR_UPPER_A = 65
const CHAR_UPPER_F = 70
const CHAR_LOWER_A = 97
const CHAR_LOWER_F = 102
const CHAR_PAYLOAD_REPLACE = HL_PAYLOAD_REPLACE.charCodeAt(0)
const CHAR_COLON = HL_HEADER_COLON.charCodeAt(0)
const FILE_PREFIX_LENGTH = HL_FILE_PREFIX.length
const FILE_SUFFIX_LENGTH = HL_FILE_SUFFIX.length

function isDigitCode(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE
}
function isNonZeroDigitCode(code: number): boolean {
  return code > CHAR_ZERO && code <= CHAR_NINE
}
function isHexDigitCode(code: number): boolean {
  return (
    isDigitCode(code) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F)
  )
}
function isWhitespaceCode(code: number): boolean {
  return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN)
}

function skipWhitespace(line: string, index: number, end = line.length): number {
  while (index < end && isWhitespaceCode(line.charCodeAt(index))) index++
  return index
}
function trimEndIndex(line: string): number {
  let end = line.length
  while (end > 0 && isWhitespaceCode(line.charCodeAt(end - 1))) end--
  return end
}
function isEmptyLine(line: string): boolean {
  return line.length === 0
}
function markerLineEquals(line: string, marker: string): boolean {
  const end = trimEndIndex(line)
  return end === marker.length && line.startsWith(marker)
}

export function splitHashlineLines(text: string): string[] {
  if (text.length === 0) return [""]
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== CHAR_LINE_FEED) continue
    let end = index
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--
    lines.push(text.slice(start, end))
    start = index + 1
  }
  if (start < text.length) {
    let end = text.length
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--
    lines.push(text.slice(start, end))
  }
  return lines
}

export function cloneCursor(cursor: Cursor): Cursor {
  if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } }
  if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } }
  return cursor
}

interface NumberScan {
  line: number
  nextIndex: number
}

function scanLineNumber(line: string, index: number, end: number): NumberScan | null {
  if (index >= end || !isNonZeroDigitCode(line.charCodeAt(index))) return null
  let lineNumber = 0,
    nextIndex = index
  while (nextIndex < end) {
    const code = line.charCodeAt(nextIndex)
    if (!isDigitCode(code)) break
    lineNumber = lineNumber * 10 + (code - CHAR_ZERO)
    nextIndex++
  }
  return { line: lineNumber, nextIndex }
}

export function parseLid(raw: string, lineNum: number): Anchor {
  const end = trimEndIndex(raw)
  const numberStart = skipWhitespace(raw, 0, end)
  const number = scanLineNumber(raw, numberStart, end)
  if (number === null || skipWhitespace(raw, number.nextIndex, end) !== end) {
    throw new Error(
      `line ${lineNum}: expected a line number such as ${describeAnchorExamples("119")}; got ${JSON.stringify(raw)}.`,
    )
  }
  return { line: number.line }
}

interface RangeScan {
  range: ParsedRange
  nextIndex: number
}

function scanRangeSeparator(line: string, index: number, end: number): number | null {
  let cursor = index,
    consumedSeparator = false
  while (cursor < end) {
    const code = line.charCodeAt(cursor)
    if (isWhitespaceCode(code)) {
      cursor++
      consumedSeparator = true
      continue
    }
    if (code === CHAR_HYPHEN || code === CHAR_ELLIPSIS) {
      cursor++
      consumedSeparator = true
      continue
    }
    if (
      code === CHAR_DOT &&
      cursor + 1 < end &&
      (line.charCodeAt(cursor + 1) === CHAR_DOT || line.charCodeAt(cursor + 1) === CHAR_EQUALS)
    ) {
      cursor += 2
      consumedSeparator = true
      continue
    }
    break
  }
  if (!consumedSeparator) return null
  if (cursor >= end || !isNonZeroDigitCode(line.charCodeAt(cursor))) return null
  return cursor
}

function scanHeaderRange(line: string, index = 0, end = trimEndIndex(line), allowSingle = false): RangeScan | null {
  const numberStart = skipWhitespace(line, index, end)
  const start = scanLineNumber(line, numberStart, end)
  if (start === null) return null
  const afterFirst = scanRangeSeparator(line, start.nextIndex, end)
  if (afterFirst === null) {
    if (!allowSingle) return null
    return {
      range: { start: { line: start.line }, end: { line: start.line } },
      nextIndex: skipWhitespace(line, start.nextIndex, end),
    }
  }
  const endNumber = scanLineNumber(line, afterFirst, end)
  if (endNumber === null) return null
  return {
    range: { start: { line: start.line }, end: { line: endNumber.line } },
    nextIndex: skipWhitespace(line, endNumber.nextIndex, end),
  }
}

export type BlockTarget =
  | { kind: "replace"; range: ParsedRange }
  | { kind: "block"; anchor: Anchor }
  | { kind: "delete"; range: ParsedRange }
  | { kind: "delete_block"; anchor: Anchor }
  | { kind: "insert_before"; anchor: Anchor }
  | { kind: "insert_after"; anchor: Anchor }
  | { kind: "insert_after_block"; anchor: Anchor }
  | { kind: "bof" }
  | { kind: "eof" }

interface TargetScan {
  target: BlockTarget
  nextIndex: number
}

function scanKeyword(line: string, index: number, end: number, keyword: string): number | null {
  if (!line.startsWith(keyword, index)) return null
  const next = index + keyword.length
  if (next < end) {
    const code = line.charCodeAt(next)
    if (!isWhitespaceCode(code) && code !== CHAR_COLON && code !== CHAR_DOT) return null
  }
  return next
}

function consumeOptionalColon(line: string, index: number, end: number): number {
  const cursor = skipWhitespace(line, index, end)
  return cursor < end && line.charCodeAt(cursor) === CHAR_COLON ? skipWhitespace(line, cursor + 1, end) : cursor
}

/** Parse OMP insert: INS.PRE N:, INS.POST N:, INS.HEAD:, INS.TAIL: */
function scanOmpInsertTarget(line: string, index: number, end: number): TargetScan | null {
  if (index >= end || line.charCodeAt(index) !== CHAR_DOT) return null
  const cursor = skipWhitespace(line, index + 1, end)
  const beforeEnd = scanKeyword(line, cursor, end, HL_INSERT_BEFORE)
  if (beforeEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, beforeEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "insert_before", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  const afterEnd = scanKeyword(line, cursor, end, HL_INSERT_AFTER)
  if (afterEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, afterEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "insert_after", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  const headEnd = scanKeyword(line, cursor, end, HL_INSERT_HEAD)
  if (headEnd !== null) return { target: { kind: "bof" }, nextIndex: consumeOptionalColon(line, headEnd, end) }
  const tailEnd = scanKeyword(line, cursor, end, HL_INSERT_TAIL)
  if (tailEnd !== null) return { target: { kind: "eof" }, nextIndex: consumeOptionalColon(line, tailEnd, end) }
  return null
}

/** Parse legacy insert: insert before N:, insert after N:, insert N before/after:, insert head:, insert tail: */
function scanLegacyInsertTarget(line: string, index: number, end: number): TargetScan | null {
  const afterKey = skipWhitespace(line, index, end)
  // "before N:"
  const beforeEnd = scanKeyword(line, afterKey, end, HL_INSERT_BEFORE.toLowerCase())
  if (beforeEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, beforeEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "insert_before", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  // "after N:"
  const afterEnd = scanKeyword(line, afterKey, end, HL_INSERT_AFTER.toLowerCase())
  if (afterEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, afterEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "insert_after", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  // "N before:" or "N after:" (number-first)
  const numFirst = scanLineNumber(line, afterKey, end)
  if (numFirst !== null) {
    const posStart = skipWhitespace(line, numFirst.nextIndex, end)
    const preLen = scanKeyword(line, posStart, end, HL_INSERT_BEFORE.toLowerCase())
    const beforeLen = scanKeyword(line, posStart, end, "before")
    if (preLen !== null || beforeLen !== null) {
      const kwLen = preLen !== null ? preLen - posStart : beforeLen! - posStart
      return {
        target: { kind: "insert_before", anchor: { line: numFirst.line } },
        nextIndex: consumeOptionalColon(line, posStart + kwLen, end),
      }
    }
    const postLen = scanKeyword(line, posStart, end, HL_INSERT_AFTER.toLowerCase())
    const afterLen = scanKeyword(line, posStart, end, "after")
    if (postLen !== null || afterLen !== null) {
      const kwLen = postLen !== null ? postLen - posStart : afterLen! - posStart
      return {
        target: { kind: "insert_after", anchor: { line: numFirst.line } },
        nextIndex: consumeOptionalColon(line, posStart + kwLen, end),
      }
    }
    return null
  }
  // "head:" or "tail:"
  const headEnd = scanKeyword(line, afterKey, end, HL_INSERT_HEAD.toLowerCase())
  if (headEnd !== null) return { target: { kind: "bof" }, nextIndex: consumeOptionalColon(line, headEnd, end) }
  const tailEnd = scanKeyword(line, afterKey, end, HL_INSERT_TAIL.toLowerCase())
  if (tailEnd !== null) return { target: { kind: "eof" }, nextIndex: consumeOptionalColon(line, tailEnd, end) }
  return null
}

function scanHunkAnchor(line: string, start: number, end: number): TargetScan | null {
  const cursor = skipWhitespace(line, start, end)

  // OMP: SWAP.BLK
  const replaceBlockEnd = scanKeyword(line, cursor, end, HL_REPLACE_BLOCK_KEYWORD)
  if (replaceBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, replaceBlockEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "block", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  // OMP: SWAP N..M
  const replaceEnd = scanKeyword(line, cursor, end, HL_REPLACE_KEYWORD)
  if (replaceEnd !== null) {
    const range = scanHeaderRange(line, replaceEnd, end, true)
    if (range === null) return null
    return {
      target: { kind: "replace", range: range.range },
      nextIndex: consumeOptionalColon(line, range.nextIndex, end),
    }
  }
  // Legacy: replace N..M
  const legacyReplaceEnd = scanKeyword(line, cursor, end, HL_LEGACY_REPLACE_KEYWORD)
  if (legacyReplaceEnd !== null) {
    const range = scanHeaderRange(line, legacyReplaceEnd, end, true)
    if (range === null) return null
    return {
      target: { kind: "replace", range: range.range },
      nextIndex: consumeOptionalColon(line, range.nextIndex, end),
    }
  }
  // OMP: DEL.BLK
  const deleteBlockEnd = scanKeyword(line, cursor, end, HL_DELETE_BLOCK_KEYWORD)
  if (deleteBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, deleteBlockEnd, end), end)
    if (anchor === null) return null
    const next = skipWhitespace(line, anchor.nextIndex, end)
    if (next < end && line.charCodeAt(next) === CHAR_COLON) return null
    return { target: { kind: "delete_block", anchor: { line: anchor.line } }, nextIndex: next }
  }
  // OMP: DEL N..M (no colon allowed)
  const deleteEnd = scanKeyword(line, cursor, end, HL_DELETE_KEYWORD)
  if (deleteEnd !== null) {
    const range = scanHeaderRange(line, deleteEnd, end, true)
    if (range === null) return null
    const next = skipWhitespace(line, range.nextIndex, end)
    if (next < end && line.charCodeAt(next) === CHAR_COLON) return null
    return { target: { kind: "delete", range: range.range }, nextIndex: next }
  }
  // Legacy: delete N..M (colon allowed)
  const legacyDeleteEnd = scanKeyword(line, cursor, end, HL_LEGACY_DELETE_KEYWORD)
  if (legacyDeleteEnd !== null) {
    const range = scanHeaderRange(line, legacyDeleteEnd, end, true)
    if (range === null) return null
    return {
      target: { kind: "delete", range: range.range },
      nextIndex: consumeOptionalColon(line, range.nextIndex, end),
    }
  }
  // OMP: INS.BLK.POST
  const insertAfterBlockEnd = scanKeyword(line, cursor, end, HL_INSERT_AFTER_BLOCK_KEYWORD)
  if (insertAfterBlockEnd !== null) {
    const anchor = scanLineNumber(line, skipWhitespace(line, insertAfterBlockEnd, end), end)
    if (anchor === null) return null
    return {
      target: { kind: "insert_after_block", anchor: { line: anchor.line } },
      nextIndex: consumeOptionalColon(line, anchor.nextIndex, end),
    }
  }
  // OMP: INS.PRE N:, INS.POST N:, INS.HEAD:, INS.TAIL:
  const insertEnd = scanKeyword(line, cursor, end, HL_INSERT_KEYWORD)
  if (insertEnd !== null) return scanOmpInsertTarget(line, insertEnd, end)
  // Legacy: insert before N:, insert after N:, etc.
  const legacyInsertEnd = scanKeyword(line, cursor, end, HL_LEGACY_INSERT_KEYWORD)
  if (legacyInsertEnd !== null) return scanLegacyInsertTarget(line, legacyInsertEnd, end)
  return null
}

function tryParseHunkHeader(line: string): { target: BlockTarget } | null {
  const end = trimEndIndex(line)
  const start = skipWhitespace(line, 0, end)
  if (start >= end) return null
  const scan = scanHunkAnchor(line, start, end)
  if (scan === null) return null
  if (scan.nextIndex !== end) return null
  return { target: scan.target }
}

function tryParseHeader(line: string): { path: string; fileHash?: string } | null {
  if (!line.startsWith(HL_FILE_PREFIX)) return null
  const end = trimEndIndex(line)
  if (FILE_PREFIX_LENGTH + FILE_SUFFIX_LENGTH >= end) return null
  if (!line.endsWith(HL_FILE_SUFFIX, end)) return null
  const bodyEnd = end - FILE_SUFFIX_LENGTH
  if (FILE_PREFIX_LENGTH >= bodyEnd) return null
  let pathEnd = bodyEnd
  let fileHash: string | undefined
  const trailingHashStart = bodyEnd - HL_FILE_HASH_LENGTH - 1
  if (trailingHashStart >= FILE_PREFIX_LENGTH && line.charCodeAt(trailingHashStart) === CHAR_HASH) {
    let allHex = true
    for (let probe = trailingHashStart + 1; probe < bodyEnd; probe++) {
      if (!isHexDigitCode(line.charCodeAt(probe))) {
        allHex = false
        break
      }
    }
    if (allHex) {
      pathEnd = trailingHashStart
      fileHash = line.slice(trailingHashStart + 1, bodyEnd).toUpperCase()
    }
  }
  for (let i = FILE_PREFIX_LENGTH; i < pathEnd; i++) {
    if (line.charCodeAt(i) === CHAR_HASH) return null
  }
  if (pathEnd === FILE_PREFIX_LENGTH) return null
  const path = line.slice(FILE_PREFIX_LENGTH, pathEnd)
  return fileHash !== undefined ? { path, fileHash } : { path }
}

interface TokenBase {
  lineNum: number
}

export type Token =
  | (TokenBase & { kind: "blank" })
  | (TokenBase & { kind: "envelope-begin" })
  | (TokenBase & { kind: "envelope-end" })
  | (TokenBase & { kind: "abort" })
  | (TokenBase & { kind: "header"; path: string; fileHash?: string })
  | (TokenBase & { kind: "op-block"; target: BlockTarget })
  | (TokenBase & { kind: "payload-literal"; text: string })
  | (TokenBase & { kind: "raw"; text: string })

function classifyLine(line: string, lineNum: number): Token {
  if (isEmptyLine(line)) return { kind: "blank", lineNum }
  if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelope-begin", lineNum }
  if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelope-end", lineNum }
  if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", lineNum }
  const firstCode = line.charCodeAt(0)
  if (line.startsWith(HL_FILE_PREFIX)) {
    const header = tryParseHeader(line)
    if (header !== null) {
      return header.fileHash !== undefined
        ? { kind: "header", lineNum, path: header.path, fileHash: header.fileHash }
        : { kind: "header", lineNum, path: header.path }
    }
  }
  const hunk = tryParseHunkHeader(line)
  if (hunk !== null) return { kind: "op-block", lineNum, target: hunk.target }
  if (firstCode === CHAR_PAYLOAD_REPLACE) return { kind: "payload-literal", lineNum, text: line.slice(1) }
  return { kind: "raw", lineNum, text: line }
}

export class Tokenizer {
  #buffer = ""
  #nextLineNum = 1
  #closed = false

  feed(chunk: string): Token[] {
    if (this.#closed) throw new Error("Tokenizer is closed; call reset() before reusing.")
    if (chunk.length === 0) return []
    this.#buffer = this.#buffer ? this.#buffer + chunk : chunk
    return this.#drainCompleteLines()
  }
  end(): Token[] {
    if (this.#closed) return []
    this.#closed = true
    const buf = this.#buffer
    this.#buffer = ""
    if (buf.length === 0) return []
    let stop = buf.length
    if (buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--
    return [classifyLine(buf.slice(0, stop), this.#nextLineNum++)]
  }
  reset(): void {
    this.#buffer = ""
    this.#nextLineNum = 1
    this.#closed = false
  }
  tokenizeAll(text: string): Token[] {
    this.reset()
    const first = this.feed(text)
    const last = this.end()
    return last.length === 0 ? first : first.concat(last)
  }
  tokenize(line: string, lineNum = 0): Token {
    return classifyLine(line, lineNum)
  }
  isOp(line: string): boolean {
    return tryParseHunkHeader(line) !== null
  }
  isHeader(line: string): boolean {
    return tryParseHeader(line) !== null
  }
  isEnvelopeMarker(line: string): boolean {
    return (
      markerLineEquals(line, BEGIN_PATCH_MARKER) ||
      markerLineEquals(line, END_PATCH_MARKER) ||
      markerLineEquals(line, ABORT_MARKER)
    )
  }
  #drainCompleteLines(): Token[] {
    const tokens: Token[] = []
    const buf = this.#buffer
    let start = 0
    for (let index = 0; index < buf.length; index++) {
      if (buf.charCodeAt(index) !== CHAR_LINE_FEED) continue
      let stop = index
      if (stop > start && buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--
      tokens.push(classifyLine(buf.slice(start, stop), this.#nextLineNum++))
      start = index + 1
    }
    this.#buffer = start < buf.length ? buf.slice(start) : ""
    return tokens
  }
}

export type { Anchor, Cursor, ParsedRange } from "./types"

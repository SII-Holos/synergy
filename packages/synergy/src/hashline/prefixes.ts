/**
 * When a hashline payload is authored against `read`/`search` output, each
 * line is prefixed with either a hashline-mode line number (`123:`) or, for
 * diff-style echoes, a leading `+`. These helpers detect that and recover
 * the raw text.
 */
import { HL_FILE_HASH_LENGTH } from "./format"

const HL_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:[+*-]\s*)?\d+:/
const HL_PREFIX_PLUS_RE = /^\s*(?:>>>|>>)?\s*\+\s*\d+:/
const HL_HEADER_RE = new RegExp(`^\\s*\\[[^#\\r\\n]+#[0-9a-fA-F]{${HL_FILE_HASH_LENGTH}}\\]\\s*$`)
const DIFF_PLUS_RE = /^[+](?![+])/
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/

function stripLeadingHashlinePrefixes(line: string): string {
  let result = line
  let previous: string
  do {
    previous = result
    result = result.replace(HL_PREFIX_RE, "")
  } while (result !== previous)
  return result
}

/** Single-pass variant: strips at most one leading hashline prefix. */
export function stripOneLeadingHashlinePrefix(line: string): string {
  return line.replace(HL_PREFIX_RE, "")
}

interface LinePrefixStats {
  nonEmpty: number
  headerCount: number
  hashPrefixCount: number
  diffPlusHashPrefixCount: number
  diffPlusCount: number
  truncationNoticeCount: number
}

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
  const stats: LinePrefixStats = {
    nonEmpty: 0,
    headerCount: 0,
    hashPrefixCount: 0,
    diffPlusHashPrefixCount: 0,
    diffPlusCount: 0,
    truncationNoticeCount: 0,
  }
  for (const line of lines) {
    if (line.length === 0) continue
    if (READ_TRUNCATION_NOTICE_RE.test(line)) {
      stats.truncationNoticeCount++
      continue
    }
    if (HL_HEADER_RE.test(line)) {
      stats.nonEmpty++
      stats.headerCount++
      continue
    }
    stats.nonEmpty++
    if (HL_PREFIX_RE.test(line)) stats.hashPrefixCount++
    if (HL_PREFIX_PLUS_RE.test(line)) stats.diffPlusHashPrefixCount++
    if (DIFF_PLUS_RE.test(line)) stats.diffPlusCount++
  }
  return stats
}

/** Strip whichever prefix scheme the lines appear to be carrying. */
export function stripNewLinePrefixes(lines: string[]): string[] {
  const stats = collectLinePrefixStats(lines)
  if (stats.nonEmpty === 0) return lines
  const contentLineCount = stats.nonEmpty - stats.headerCount
  const stripHash = contentLineCount > 0 && stats.hashPrefixCount === contentLineCount
  const stripPlus =
    !stripHash &&
    stats.diffPlusHashPrefixCount === 0 &&
    stats.diffPlusCount > 0 &&
    stats.diffPlusCount >= stats.nonEmpty * 0.5
  if (!stripHash && !stripPlus && stats.diffPlusHashPrefixCount === 0) return lines
  return lines
    .filter((line) => !READ_TRUNCATION_NOTICE_RE.test(line) && !(stripHash && HL_HEADER_RE.test(line)))
    .map((line) => {
      if (stripHash) return stripLeadingHashlinePrefixes(line)
      if (stripPlus) return line.replace(DIFF_PLUS_RE, "")
      if (stats.diffPlusHashPrefixCount > 0 && HL_PREFIX_PLUS_RE.test(line)) return line.replace(HL_PREFIX_RE, "")
      return line
    })
}

/** Strict variant: strip hashline prefixes only when every content line is hashline-prefixed. */
export function stripHashlinePrefixes(lines: string[]): string[] {
  const stats = collectLinePrefixStats(lines)
  if (stats.nonEmpty === 0) return lines
  const contentLineCount = stats.nonEmpty - stats.headerCount
  if (contentLineCount === 0 || stats.hashPrefixCount !== contentLineCount) return lines
  return lines
    .filter((line) => !READ_TRUNCATION_NOTICE_RE.test(line) && !HL_HEADER_RE.test(line))
    .map((line) => stripLeadingHashlinePrefixes(line))
}

/** Normalize line payloads by stripping read/search line prefixes. */
export function hashlineParseText(edit: string[] | string | null | undefined): string[] {
  if (edit == null) return []
  if (typeof edit === "string") {
    const trimmed = edit.endsWith("\n") ? edit.slice(0, -1) : edit
    edit = trimmed.replaceAll("\r", "").split("\n")
  }
  return stripNewLinePrefixes(edit)
}

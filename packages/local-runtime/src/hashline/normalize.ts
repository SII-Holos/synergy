/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 *
 * Also re-exports `computeTag` (file-hash) for backward compatibility with
 * the tool bridge (tag.ts → normalize.ts migration).
 */

import { computeFileHash } from "./format"
export type LineEnding = "\r\n" | "\n"

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n")
  const lfIdx = content.indexOf("\n")
  if (lfIdx === -1) return "\n"
  if (crlfIdx === -1) return "\n"
  return crlfIdx < lfIdx ? "\r\n" : "\n"
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

export interface BomResult {
  bom: string
  text: string
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content }
}

// ── Backward compatibility with tag.ts ──

/**
 * Normalize content before hashing: trim trailing whitespace from every line.
 * Replaces `normalizeContent` from tag.ts.
 */
export function normalizeContent(content: string): string {
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+(?=\n|$)/g, "")
}

/**
 * Split normalized content into lines, dropping the trailing empty sentinel.
 * Replaces `splitContentLines` from tag.ts.
 */
export function splitContentLines(content: string): string[] {
  const normalized = normalizeContent(content)
  if (normalized === "") return []
  const lines = normalized.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/**
 * Compute a 4-hex content-hash tag via Bun's xxHash32.
 * Replaces `computeTag` from tag.ts.
 */
export function computeTag(content: string): string {
  return computeFileHash(content)
}

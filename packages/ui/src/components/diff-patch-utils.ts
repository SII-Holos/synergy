import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"

/**
 * Returns true when `patch` is a parseable unified diff for exactly one real
 * file. Multi-file patches and the synthetic combined diff produced by
 * revise_file (multiple `=== path ===` sections wrapped in one
 * `createTwoFilesPatch("file", "file", ...)` call) are not eligible for
 * pierre rendering — the combined diff parses as a single "file" entry whose
 * line numbers span all sections, which renders as a misleading merged blob.
 *
 * Kept in its own module so unit tests can import it without pulling in the
 * vite-specific worker URL imports used by the DiffPatch component.
 */
const TRUNCATION_MARKER = /\[\d[\d,]* characters omitted\]/
const SECTION_MARKER = /^=== .+ ===\s*$/

function hasUnrenderableTrailingBlankLine(lines: readonly string[]): boolean {
  return /^\r?\n$/.test(lines.at(-1) ?? "")
}

/**
 * Parses `patch` once and returns the single-file metadata when pierre can
 * render it, or `undefined` otherwise. Callers use the same result for both
 * the renderability decision and the render itself so streaming projections
 * that rebuild wrapper objects around an unchanged patch string do not pay a
 * fresh `parsePatchFiles` cost per chunk.
 */
export function parseRenderablePatch(patch: string | undefined | null): FileDiffMetadata | undefined {
  if (!patch || !patch.trim()) return undefined
  // Truncated previews (middle-omitted by SessionBounds) still parse as valid
  // unified diffs but render as broken/incomplete hunks — keep them on the
  // lightweight fallback that surfaces the truncation notice.
  if (TRUNCATION_MARKER.test(patch)) return undefined
  try {
    const parsed = parsePatchFiles(patch)
    if (parsed.length !== 1 || parsed[0].files.length !== 1) return undefined
    const metadata = parsed[0].files[0]
    // The combined revise_file diff embeds `=== path ===` section headers in
    // the hunk content lines (each section's before/after is concatenated
    // into one synthetic file). Reject those so the multi-file result does
    // not render as a misleading merged blob with line numbers spanning all
    // sections. A file whose content legitimately contains such a marker is
    // only demoted to the lightweight preview — acceptable.
    if (
      metadata.deletionLines?.some((line) => SECTION_MARKER.test(line)) ||
      metadata.additionLines?.some((line) => SECTION_MARKER.test(line))
    ) {
      return undefined
    }
    // Pierre strips the final newline before highlighting, so an empty final
    // hunk line leaves its renderer with a line index but no highlighted row.
    if (
      hasUnrenderableTrailingBlankLine(metadata.deletionLines) ||
      hasUnrenderableTrailingBlankLine(metadata.additionLines)
    ) {
      return undefined
    }
    return metadata
  } catch {
    return undefined
  }
}

export function canRenderPatch(patch: string | undefined | null): boolean {
  return parseRenderablePatch(patch) !== undefined
}

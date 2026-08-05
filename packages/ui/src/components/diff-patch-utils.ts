import { parsePatchFiles } from "@pierre/diffs"

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

export function canRenderPatch(patch: string | undefined | null): boolean {
  if (!patch || !patch.trim()) return false
  // Truncated previews (middle-omitted by SessionBounds) still parse as valid
  // unified diffs but render as broken/incomplete hunks — keep them on the
  // lightweight fallback that surfaces the truncation notice.
  if (TRUNCATION_MARKER.test(patch)) return false
  try {
    const parsed = parsePatchFiles(patch)
    if (parsed.length !== 1 || parsed[0].files.length !== 1) return false
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
      return false
    }
    return true
  } catch {
    return false
  }
}

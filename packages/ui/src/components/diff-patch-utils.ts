import { parsePatchFiles } from "@pierre/diffs"

/**
 * Returns true when `patch` is a parseable unified diff for exactly one file.
 * Multi-file or non-unified patches (e.g. the combined `=== path ===` sections
 * produced by revise_file) are not eligible for pierre rendering.
 *
 * Kept in its own module so unit tests can import it without pulling in the
 * vite-specific worker URL imports used by the DiffPatch component.
 */
const TRUNCATION_MARKER = /\[\d[\d,]* characters omitted\]/

export function canRenderPatch(patch: string | undefined | null): boolean {
  if (!patch || !patch.trim()) return false
  // Truncated previews (middle-omitted by SessionBounds) still parse as valid
  // unified diffs but render as broken/incomplete hunks — keep them on the
  // lightweight fallback that surfaces the truncation notice.
  if (TRUNCATION_MARKER.test(patch)) return false
  try {
    const parsed = parsePatchFiles(patch)
    return parsed.length > 0 && parsed[0].files.length === 1
  } catch {
    return false
  }
}

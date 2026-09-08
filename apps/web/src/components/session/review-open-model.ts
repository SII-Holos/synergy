/**
 * Computes whether the review open list needs to be updated for a given selected file.
 *
 * Pure function — no dependencies on Solid, DOM, or any UI framework.
 *
 * Returns undefined when no setOpen call is needed:
 *   - no selected file
 *   - selected file is not in the diff list
 *   - selected file is already open
 */
export function computeReviewOpenForSelectedFile(
  selected: string | undefined,
  diffsFiles: readonly string[],
  currentOpen: readonly string[],
): string[] | undefined {
  if (!selected) return undefined
  if (!diffsFiles.includes(selected)) return undefined
  if (currentOpen.includes(selected)) return undefined
  return [...currentOpen, selected]
}

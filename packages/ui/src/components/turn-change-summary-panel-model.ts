export type TurnChangeSummaryDiff = {
  file: string
  additions: number
  deletions: number
  binary?: boolean
}

export function turnChangeSummaryTitle(fileCount: number) {
  return `Changed ${fileCount} ${fileCount === 1 ? "file" : "files"}`
}

export function turnChangeSummaryHiddenCount(diffs: TurnChangeSummaryDiff[], previewLimit = 3) {
  return Math.max(0, diffs.length - previewLimit)
}

export function turnChangeSummaryVisibleDiffs(
  diffs: TurnChangeSummaryDiff[],
  input?: { expanded?: boolean; previewLimit?: number },
) {
  return input?.expanded ? diffs : diffs.slice(0, input?.previewLimit ?? 3)
}

export function turnChangeSummaryToggleLabel(input: { expanded: boolean; hiddenCount: number }) {
  if (input.expanded) return "Hide files"
  return `Show ${input.hiddenCount} more ${input.hiddenCount === 1 ? "file" : "files"}`
}

import type { I18n, MessageDescriptor } from "@lingui/core"

export type TurnChangeSummaryDiff = {
  file: string
  additions: number
  deletions: number
  binary?: boolean
}

function d(id: string, message: string): MessageDescriptor {
  return { id, message }
}

const TITLE_DESC = /** i18n */ {
  id: "ui.turnChangeSummary.title",
  message: "Changed {fileCount, plural, one {# file} other {# files}}",
}
const HIDE_DESC = /** i18n */ { id: "ui.turnChangeSummary.hideFiles", message: "Hide files" }
const SHOW_DESC = /** i18n */ {
  id: "ui.turnChangeSummary.showMore",
  message: "Show {count} more {count, plural, one {file} other {files}}",
}

export function turnChangeSummaryTitle(fileCount: number, i18n?: I18n) {
  if (i18n) return i18n._({ ...TITLE_DESC, values: { fileCount } })
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

export function turnChangeSummaryToggleLabel(input: { expanded: boolean; hiddenCount: number }, i18n?: I18n) {
  if (input.expanded) {
    if (i18n) return i18n._(HIDE_DESC)
    return "Hide files"
  }
  if (i18n) return i18n._({ ...SHOW_DESC, values: { count: input.hiddenCount } })
  return `Show ${input.hiddenCount} more ${input.hiddenCount === 1 ? "file" : "files"}`
}

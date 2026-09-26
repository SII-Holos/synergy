import type { I18n } from "@lingui/core"
import type { FileDiff } from "@ericsanchezok/synergy-sdk"
import { reviewFileKey } from "./session-review-model"

export type TurnChangeSummaryDiff = Pick<
  FileDiff,
  "file" | "workspace" | "legacyRoot" | "operationID" | "additions" | "deletions" | "binary"
>

export function turnChangeSummaryFiles(diffs: TurnChangeSummaryDiff[]) {
  const files = new Map<string, TurnChangeSummaryDiff>()
  for (const diff of diffs) {
    const { operationID: _operationID, ...file } = diff
    const key = reviewFileKey(file)
    const previous = files.get(key)
    files.set(
      key,
      previous
        ? {
            ...file,
            additions: previous.additions + file.additions,
            deletions: previous.deletions + file.deletions,
            ...(previous.binary || file.binary ? { binary: true } : {}),
          }
        : file,
    )
  }
  return [...files.values()]
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

export type TurnDiffPanelState = "hidden" | "pending" | "ready" | "error"

export const TURN_DIFF_PENDING_DELAY_MS = 150

export function resolveTurnDiffPanelState(state: TurnDiffPanelState, pendingDelayElapsed: boolean): TurnDiffPanelState {
  if (state === "pending" && !pendingDelayElapsed) return "hidden"
  return state
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

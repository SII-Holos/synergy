import { describe, expect, test } from "bun:test"
import {
  resolveTurnDiffPanelState,
  turnChangeSummaryHiddenCount,
  turnChangeSummaryFiles,
  turnChangeSummaryTitle,
  turnChangeSummaryToggleLabel,
  turnChangeSummaryVisibleDiffs,
  type TurnChangeSummaryDiff,
  type TurnDiffPanelState,
} from "../../src/components/turn-change-summary-panel-model"

const diffs: TurnChangeSummaryDiff[] = [
  { file: "apps/web/src/pages/session.tsx", additions: 10, deletions: 2 },
  { file: "packages/ui/src/components/session-turn.tsx", additions: 5, deletions: 1 },
  { file: "README.md", additions: 1, deletions: 0 },
  { file: "assets/logo.png", additions: 0, deletions: 0, binary: true },
]

describe("TurnChangeSummaryPanel helpers", () => {
  test("formats singular and plural file count titles", () => {
    expect(turnChangeSummaryTitle(1)).toBe("Changed 1 file")
    expect(turnChangeSummaryTitle(4)).toBe("Changed 4 files")
  })

  test("shows first three files while collapsed and all files while expanded", () => {
    expect(turnChangeSummaryHiddenCount(diffs)).toBe(1)
    expect(turnChangeSummaryVisibleDiffs(diffs).map((diff) => diff.file)).toEqual([
      "apps/web/src/pages/session.tsx",
      "packages/ui/src/components/session-turn.tsx",
      "README.md",
    ])
    expect(turnChangeSummaryVisibleDiffs(diffs, { expanded: true }).map((diff) => diff.file)).toEqual(
      diffs.map((diff) => diff.file),
    )
  })

  test("supports custom preview limits and footer labels", () => {
    expect(turnChangeSummaryHiddenCount(diffs, 2)).toBe(2)
    expect(turnChangeSummaryVisibleDiffs(diffs, { previewLimit: 2 }).map((diff) => diff.file)).toEqual([
      "apps/web/src/pages/session.tsx",
      "packages/ui/src/components/session-turn.tsx",
    ])
    expect(turnChangeSummaryToggleLabel({ expanded: false, hiddenCount: 1 })).toBe("Show 1 more file")
    expect(turnChangeSummaryToggleLabel({ expanded: false, hiddenCount: 2 })).toBe("Show 2 more files")
    expect(turnChangeSummaryToggleLabel({ expanded: true, hiddenCount: 2 })).toBe("Hide files")
  })

  test("shows a change card only when recorded files exist", () => {
    const states: TurnDiffPanelState[] = ["hidden", "pending", "ready", "partial", "error"]
    for (const state of states) {
      expect(resolveTurnDiffPanelState(state, false)).toBe("hidden")
      expect(resolveTurnDiffPanelState(state, true)).toBe(state)
    }
  })

  test("retains confirmed binary and empty-file changes with zero line counts", () => {
    const files = turnChangeSummaryFiles([
      { file: "empty.txt", additions: 0, deletions: 0 },
      { file: "image.png", additions: 0, deletions: 0, binary: true },
    ])
    expect(files).toHaveLength(2)
    expect(resolveTurnDiffPanelState("partial", files.length > 0)).toBe("partial")
  })
})

test("the summary preserves backend net counts without adding obsolete operation totals", () => {
  const workspace = { id: "wsp_a", generation: 1, root: "/a" }
  const files = turnChangeSummaryFiles([
    { file: "same.txt", workspace, operationID: "first", additions: 1, deletions: 2 },
    { file: "same.txt", workspace, operationID: "last", additions: 3, deletions: 4 },
    { file: "same.txt", workspace: { ...workspace, id: "wsp_b", root: "/b" }, additions: 1, deletions: 0 },
  ])
  expect(files).toHaveLength(2)
  expect(files[0]).toMatchObject({ file: "same.txt", workspace, additions: 3, deletions: 4 })
  expect(files[0]?.operationID).toBeUndefined()
})

import { describe, expect, test } from "bun:test"
import {
  turnChangeSummaryHiddenCount,
  turnChangeSummaryTitle,
  turnChangeSummaryToggleLabel,
  turnChangeSummaryVisibleDiffs,
  type TurnChangeSummaryDiff,
} from "./turn-change-summary-panel-model"

const diffs: TurnChangeSummaryDiff[] = [
  { file: "packages/app/src/pages/session.tsx", additions: 10, deletions: 2 },
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
      "packages/app/src/pages/session.tsx",
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
      "packages/app/src/pages/session.tsx",
      "packages/ui/src/components/session-turn.tsx",
    ])
    expect(turnChangeSummaryToggleLabel({ expanded: false, hiddenCount: 1 })).toBe("Show 1 more file")
    expect(turnChangeSummaryToggleLabel({ expanded: false, hiddenCount: 2 })).toBe("Show 2 more files")
    expect(turnChangeSummaryToggleLabel({ expanded: true, hiddenCount: 2 })).toBe("Hide files")
  })
})

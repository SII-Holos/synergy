import { expect, test } from "bun:test"
import { parseToolReviewSource, toolReviewSource, toolReviewDiffs } from "../../src/context/tool-review-target"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"

function toolPart(metadata: Record<string, unknown>): ToolPart {
  return {
    id: "part",
    sessionID: "session",
    messageID: "message",
    callID: "call",
    tool: "edit",
    type: "tool",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      time: { start: 0, end: 1 },
      metadata,
    },
  }
}

test("review tabs persist only tool identity and reject malformed or ordinary message sources", () => {
  const target = { sessionID: "session", messageID: "message", partID: "part" }
  expect(parseToolReviewSource(toolReviewSource(target))).toEqual(target)
  expect(parseToolReviewSource("message")).toBeUndefined()
  expect(parseToolReviewSource("tool:[null]")).toBeUndefined()
})

test("review uses the stored tool patch, including content outside the inline preview", () => {
  const patch = "@@ -1 +1 @@\n-old\n+" + "new".repeat(10000)
  const part = toolPart({ diff: patch, filediff: { file: "file.ts", additions: 1, deletions: 1, preview: "short" } })
  expect(toolReviewDiffs(part)[0]?.patch).toBe(patch)
  expect(toolReviewDiffs(part)[0]?.file).toBe("file.ts")
})

test("multiple edits to the same file remain one review row containing every recorded patch", () => {
  const part = toolPart({
    results: [
      { diff: "+first", filediff: { file: "file.ts", additions: 1 } },
      { diff: "+second", filediff: { file: "file.ts", additions: 1, truncated: true } },
    ],
  })
  const diffs = toolReviewDiffs(part)
  expect(diffs).toHaveLength(1)
  expect(diffs[0]?.patch).toBe("+first\n+second")
  expect(diffs[0]?.truncated).toBe(true)
})

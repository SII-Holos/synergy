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

test("multi-file revisions open each recorded file diff instead of the synthetic aggregate", () => {
  const part = toolPart({
    diff: "synthetic aggregate",
    filediff: { file: "a.ts, b.ts" },
    sections: [
      { path: "a.ts", filediff: { file: "a.ts", preview: "+actual a", additions: 1 } },
      { path: "b.ts", filediff: { file: "b.ts", preview: "+actual b", additions: 1 } },
    ],
  })
  part.tool = "revise_file"
  expect(toolReviewDiffs(part).map(({ file, patch }) => ({ file, patch }))).toEqual([
    { file: "a.ts", patch: "+actual a" },
    { file: "b.ts", patch: "+actual b" },
  ])
})

test("patch review uses observed file identities and excludes unattempted or uncertain effects", () => {
  const part = toolPart({
    sections: [
      {
        source: "a.ts",
        destination: "b.ts",
        state: "failed",
        observedPath: "a.ts",
        diff: "+saved",
        filediff: { file: "a.ts", additions: 1 },
      },
      { source: "c.ts", state: "not_started" },
      { source: "d.ts", destination: "e.ts", state: "unknown", diff: "+planned" },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "b.ts")).toEqual([
    { file: "a.ts", additions: 1, deletions: 0, patch: "+saved", preview: "+saved" },
  ])
})

test("historical revisions without per-file evidence retain their saved fallback", () => {
  const part = toolPart({
    diff: "legacy diff",
    filediff: { file: "a.ts" },
    sections: [{ path: "a.ts", applied: true }],
  })
  part.tool = "revise_file"
  expect(toolReviewDiffs(part)[0]?.patch).toBe("legacy diff")
})

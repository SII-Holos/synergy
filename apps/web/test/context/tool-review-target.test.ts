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

test("non-section tools retain their saved patch when files metadata is an unrelated list", () => {
  const part = toolPart({
    diff: "+saved",
    filediff: { file: "file.ts", additions: 1 },
    files: [],
  })
  expect(toolReviewDiffs(part)).toEqual([
    { file: "file.ts", additions: 1, deletions: 0, patch: "+saved", preview: "+saved" },
  ])
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

test("move review prefers both recorded files to the last observed source deletion", () => {
  const part = toolPart({
    sections: [
      {
        source: "old.ts",
        destination: "nested/new.ts",
        state: "committed",
        observedPath: "old.ts",
        diff: "-source",
        filediff: { file: "old.ts", additions: 0, deletions: 1, preview: "-source" },
        files: [
          {
            file: "nested/new.ts",
            additions: 1,
            deletions: 1,
            patch: "-destination\n+replacement",
            preview: "short preview with characters omitted",
            truncated: true,
          },
          { file: "old.ts", additions: 0, deletions: 1, preview: "-source" },
        ],
      },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "nested/new.ts")).toEqual([
    {
      file: "nested/new.ts",
      additions: 1,
      deletions: 1,
      patch: "-destination\n+replacement",
      preview: "-destination\n+replacement",
      truncated: true,
    },
    { file: "old.ts", additions: 0, deletions: 1, patch: "-source", preview: "-source" },
  ])
})

test("partial move review includes only the destination write before source deletion failed", () => {
  const part = toolPart({
    sections: [
      {
        source: "old.ts",
        destination: "nested/new.ts",
        state: "failed",
        files: [{ file: "nested/new.ts", additions: 1, deletions: 0, patch: "+replacement", preview: "+short" }],
        operations: [
          { phase: "write", path: "nested/new.ts", state: "committed" },
          { phase: "delete", path: "old.ts", state: "failed" },
        ],
      },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "old.ts")).toEqual([
    { file: "nested/new.ts", additions: 1, deletions: 0, patch: "+replacement", preview: "+replacement" },
  ])
})

test("historical move review retains only the single saved file identity", () => {
  const part = toolPart({
    sections: [
      {
        source: "old.ts",
        destination: "new.ts",
        state: "committed",
        diff: "+legacy",
        filediff: { file: "old.ts", additions: 1, deletions: 0 },
      },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "new.ts")).toEqual([
    { file: "old.ts", additions: 1, deletions: 0, patch: "+legacy", preview: "+legacy" },
  ])
})

test("patch review never recovers inferred effects from empty or unknown file receipts", () => {
  const part = toolPart({
    diff: "+aggregate",
    filediff: { file: "new.ts" },
    files: [{ file: "new.ts", additions: 1, deletions: 0, preview: "+aggregate" }],
    sections: [
      {
        source: "old.ts",
        destination: "new.ts",
        state: "unknown",
        observedPath: "old.ts",
        diff: "+stale",
        files: [],
      },
      { source: "old.ts", destination: "new.ts", state: "unknown", diff: "+planned" },
      { source: "old.ts", destination: "new.ts", state: "not_started", files: [null, { preview: "+invalid" }] },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "new.ts")).toEqual([])
})

test("recorded patch files without text previews retain their identity without a fabricated patch", () => {
  const part = toolPart({
    sections: [
      {
        source: "old.ts",
        destination: "new.ts",
        state: "unknown",
        observedPath: "old.ts",
        diff: "+planned",
        files: [{ file: "recorded.ts", additions: 0, deletions: 0 }],
      },
    ],
  })
  part.tool = "apply_patch"
  expect(toolReviewDiffs(part, "new.ts")).toEqual([{ file: "recorded.ts", additions: 0, deletions: 0 }])
})

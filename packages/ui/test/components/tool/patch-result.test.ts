import { expect, test } from "bun:test"
import { patchOutcome, patchSections } from "../../../src/components/tool/patch-result"

test("partial patch presentation retains recorded paths, states and diffs without inventing success", () => {
  expect(patchOutcome("partial")).toBe("partial")
  expect(patchOutcome("unresolved")).toBe("unresolved")
  expect(patchOutcome("success")).toBeUndefined()
  expect(patchSections(undefined)).toEqual([])
  expect(patchSections([{}, { source: "invalid", state: "success" }])).toEqual([])
  expect(
    patchSections([
      {
        source: "a.ts",
        destination: "b.ts",
        state: "failed",
        phase: "move",
        diff: "verified diff",
        observedPath: "a.ts",
        operations: [
          { phase: "write", state: "committed" },
          { phase: "move", state: "failed" },
          { phase: "bad", state: "success" },
        ],
      },
      { source: "c.ts", state: "unknown", phase: "write" },
      { source: "d.ts", state: "not_started", phase: "prepared" },
    ]),
  ).toMatchObject([
    {
      source: "a.ts",
      destination: "b.ts",
      state: "failed",
      phase: "move",
      diff: "verified diff",
      observedPath: "a.ts",
      operations: [
        { phase: "write", state: "committed" },
        { phase: "move", state: "failed" },
      ],
    },
    {
      source: "c.ts",
      destination: undefined,
      state: "unknown",
      phase: "write",
      diff: undefined,
      observedPath: undefined,
      operations: [],
    },
    {
      source: "d.ts",
      destination: undefined,
      state: "not_started",
      phase: "prepared",
      diff: undefined,
      observedPath: undefined,
      operations: [],
    },
  ])
})

test("historical patch diffs use their recorded file identity without guessing a move destination", () => {
  const sections = patchSections([
    {
      source: "old.ts",
      destination: "new.ts",
      operation: "update",
      state: "committed",
      diff: "verified",
      filediff: { file: "new.ts" },
    },
    { source: "old.ts", destination: "new.ts", state: "failed", diff: "verified", filediff: { file: "old.ts" } },
    { source: "old.ts", destination: "new.ts", state: "unknown", diff: "planned" },
    {
      source: "old.ts",
      destination: "new.ts",
      state: "failed",
      diff: "verified",
      observedPath: "old.ts",
      filediff: { file: "new.ts" },
    },
  ])
  expect(sections.map((section) => section.observedPath)).toEqual(["new.ts", "old.ts", undefined, "old.ts"])
})

test("move presentation retains both recorded file patches instead of only the last observed path", () => {
  const sections = patchSections([
    {
      source: "old.ts",
      destination: "nested/new.ts",
      state: "committed",
      observedPath: "old.ts",
      diff: "-source",
      filediff: { file: "old.ts", preview: "-source" },
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
  ])
  expect(sections[0]?.files).toEqual([
    { file: "nested/new.ts", patch: "-destination\n+replacement" },
    { file: "old.ts", patch: "-source" },
  ])
})

test("partial moves retain only the destination write recorded before source deletion failed", () => {
  const sections = patchSections([
    {
      source: "old.ts",
      destination: "nested/new.ts",
      state: "failed",
      observedPath: "nested/new.ts",
      diff: "legacy single diff",
      files: [{ file: "nested/new.ts", additions: 1, deletions: 0, preview: "+replacement" }],
      operations: [
        { phase: "write", path: "nested/new.ts", state: "committed" },
        { phase: "delete", path: "old.ts", state: "failed" },
      ],
    },
  ])
  expect(sections[0]?.files).toEqual([{ file: "nested/new.ts", patch: "+replacement" }])
})

test("empty or previewless file evidence never falls back to planned or single-path effects", () => {
  const sections = patchSections([
    {
      source: "old.ts",
      destination: "new.ts",
      state: "unknown",
      observedPath: "old.ts",
      diff: "+stale single diff",
      files: [],
    },
    { source: "old.ts", destination: "new.ts", state: "unknown", diff: "+planned" },
    {
      source: "old.ts",
      destination: "new.ts",
      state: "unknown",
      observedPath: "old.ts",
      diff: "+stale single diff",
      files: [
        null,
        { file: 1 },
        { file: "", preview: "+invalid" },
        { file: "recorded.ts", additions: 0, deletions: 0 },
      ],
    },
  ])
  expect(sections.map((section) => section.files)).toEqual([[], [], [{ file: "recorded.ts", patch: undefined }]])
})

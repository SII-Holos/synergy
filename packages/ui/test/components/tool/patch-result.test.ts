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

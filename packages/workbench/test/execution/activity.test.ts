import { expect, test } from "bun:test"
import { ExecutionActivity } from "../../src/execution/activity"
import { ExecutionSchema } from "../../src/execution/schema"

const row = (id: string, kind: ExecutionSchema.Node["kind"], extra: Partial<ExecutionSchema.Node> = {}) =>
  ExecutionSchema.Node.parse({
    id,
    kind,
    sessionID: "root",
    runID: "r1",
    parentID: null,
    started: 1,
    title: id,
    preview: "",
    status: "completed",
    revision: 1,
    source: "recorded",
    ...extra,
  })
test("activity counts physical requests once and distinguishes user input from delegation instructions", () => {
  const result = ExecutionActivity.project(
    [
      row("round", "turn"),
      row("input", "input", { parentID: "round" }),
      row("child", "subtask", { parentID: "round", sessionID: "child", runID: "c1" }),
      row("child-input", "input", { sessionID: "child", runID: "c1", parentID: "child" }),
      row("call", "model", { evidenceKind: "call" }),
      row("attempt", "model", { parentID: "call", evidenceKind: "attempt", attemptIndex: 0 }),
      row("retry", "retry", { parentID: "call", evidenceKind: "attempt", attemptIndex: 1 }),
    ],
    "root",
  )
  expect(result.nodes.map((node) => node.id)).toEqual(["input", "child", "attempt", "retry"])
  expect(result.humanInputs).toBe(1)
  expect(result.taskInstructions).toBe(1)
  expect(result.segments[0]).toMatchObject({ runID: "r1", count: 4 })
})
test("ten thousand activities retain real aggregate counts within the overview budget", () => {
  const result = ExecutionActivity.project(
    Array.from({ length: 10_000 }, (_, i) => row(String(i), "tool", { runID: "r" + i, started: i + 1 })),
    "root",
  )
  const lane = ExecutionActivity.aggregate(result.nodes, "tool")
  expect(lane.length).toBeLessThanOrEqual(160)
  expect(lane.reduce((sum, node) => sum + node.activity!.count, 0)).toBe(10_000)
  expect(result.segments.length).toBeLessThanOrEqual(160)
  expect(result.segments.reduce((sum, segment) => sum + segment.count, 0)).toBe(10_000)
})

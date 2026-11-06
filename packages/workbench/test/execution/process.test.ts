import { expect, test } from "bun:test"
import { ExecutionProcess } from "../../src/execution/process"
import { ExecutionSchema } from "../../src/execution/schema"

const node = (
  id: string,
  kind: ExecutionSchema.Node["kind"],
  parentID: string | null = null,
  extra: Partial<ExecutionSchema.Node> = {},
) =>
  ExecutionSchema.Node.parse({
    id,
    sessionID: "root",
    runID: "r1",
    parentID,
    kind,
    title: id,
    preview: "",
    started: 1,
    status: "completed",
    revision: 1,
    source: "recorded",
    ...extra,
  })
test("process groups initial evidence and retains real retries and their outcome", () => {
  const rows = ExecutionProcess.project(
    [
      node("round", "turn"),
      node("call", "model", "round", { evidenceKind: "call", purpose: "conversation" }),
      node("first", "model", "call", { evidenceKind: "attempt", attemptIndex: 0, status: "failed", preview: "429" }),
      node("retry", "retry", "call", { evidenceKind: "attempt", attemptIndex: 1 }),
      node("answer", "output", "call"),
    ],
    "process",
  )
  expect(rows.map((row) => row.id)).toEqual(["round", "retry", "answer"])
  expect(rows.at(-1)?.group).toMatchObject({ id: "call", attemptCount: 2, retryCount: 1, anomalies: 1 })
  expect(rows.at(-1)?.ancestors?.map((row) => row.id)).toEqual(["round", "call"])
})
test("auxiliary calls and missing purpose remain explicit, without invented ancestry", () => {
  const rows = ExecutionProcess.project(
    [
      node("aux", "model", null, { evidenceKind: "call", usageRole: "auxiliary" }),
      node("child", "subtask", null, { attribution: "unassigned" }),
    ],
    "process",
  )
  expect(rows).toHaveLength(2)
  expect(rows[0].group?.purpose).toBeNull()
  expect(rows[1].ancestors).toEqual([])
  expect(rows[1].attribution).toBe("unassigned")
})
test("round attribution follows saved parentage and leaves unrelated child runs unassigned", () => {
  const rows = ExecutionProcess.project(
    [
      node("root-turn", "turn", null),
      node("delegated", "subtask", "root-turn", { sessionID: "child", runID: "cr" }),
      node("child-call", "model", "delegated", { sessionID: "child", runID: "cr", evidenceKind: "call", started: 50 }),
      node("child-tool", "tool", "child-call", { sessionID: "child", runID: "cr" }),
      node("unassigned", "tool", null, { sessionID: "child", runID: "older" }),
    ],
    "records",
    "root",
  )
  expect(rows.find((value) => value.id === "child-tool")?.rootRunID).toBe("r1")
  expect(rows.find((value) => value.id === "child-tool")?.group?.started).toBe(50)
  expect(rows.find((value) => value.id === "unassigned")?.rootRunID).toBeNull()
})
test("projection keeps stable identities across records and process modes at ten thousand events", () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => node(String(i), "tool"))
  expect(ExecutionProcess.project(rows, "process").map((row) => row.id)).toEqual(rows.map((row) => row.id))
})
test("auxiliary purposes group within their saved owner and round, with retries still inspectable", () => {
  const source = [
    node("a", "model", null, { evidenceKind: "call", usageRole: "auxiliary", purpose: "title", started: 2 }),
    node("a-first", "model", "a", { evidenceKind: "attempt", attemptIndex: 0 }),
    node("b", "model", null, {
      evidenceKind: "call",
      usageRole: "auxiliary",
      purpose: "title",
      started: 3,
      status: "failed",
    }),
    node("b-first", "model", "b", { evidenceKind: "attempt", attemptIndex: 0, status: "failed" }),
    node("b-retry", "retry", "b", { evidenceKind: "attempt", attemptIndex: 1 }),
    node("other-round", "model", null, { evidenceKind: "call", usageRole: "auxiliary", purpose: "title", runID: "r2" }),
    node("child-title", "model", null, {
      evidenceKind: "call",
      usageRole: "auxiliary",
      purpose: "title",
      sessionID: "child",
    }),
    node("embedding", "model", null, { evidenceKind: "call", modelKind: "embedding", started: 4 }),
    node("embedding-2", "model", null, { evidenceKind: "call", modelKind: "embedding", started: 5 }),
  ]
  const rows = ExecutionProcess.project(source, "process")
  expect(rows.map((row) => row.id)).toEqual(["a", "b-retry", "other-round", "child-title", "embedding"])
  expect(rows[0]).toMatchObject({
    status: "failed",
    group: { callCount: 2, attemptCount: 3, retryCount: 1, purpose: "title" },
  })
  expect(rows.at(-1)?.group).toMatchObject({ callCount: 2, purpose: null })
  expect(ExecutionProcess.auxiliaryMembers(source, rows[0]!).map((row) => row.id)).toEqual(["a", "b"])
  expect(ExecutionProcess.project(source, "records")).toHaveLength(source.length)
})

import { expect, test } from "bun:test"
import type { ExecutionTrajectoryNode } from "@ericsanchezok/synergy-sdk/client"
import { mergeExecutionWindow, executionWindowMatches, executionOrder } from "../../../src/components/execution/window"

const row = (index: number, status: ExecutionTrajectoryNode["status"] = "completed"): ExecutionTrajectoryNode => ({
  id: String(index),
  sessionID: "root",
  runID: "round",
  parentID: null,
  kind: "tool",
  title: "read " + index,
  preview: "",
  started: index,
  status,
  revision: index,
  source: "recorded",
})
test("live windows remain bounded while stable identities converge", () => {
  const result = mergeExecutionWindow(
    Array.from({ length: 500 }, (_, i) => row(i)),
    [row(500), row(499, "failed")],
    ["498"],
    { history: false },
  )
  expect(result.rows).toHaveLength(500)
  expect(result.rows.find((node) => node.id === "499")?.status).toBe("failed")
  expect(result.rows.some((node) => node.id === "498")).toBe(false)
})
test("reading history retains its first row and counts unseen arrivals", () => {
  const result = mergeExecutionWindow([row(1), row(2)], [row(0), row(3), row(2, "failed")], [], { history: true })
  expect(result.rows.map((node) => node.id)).toEqual(["1", "2"])
  expect(result.added).toBe(2)
  expect(result.rows[1].status).toBe("failed")
})
test("paging and live merges preserve selected round and physical call order", () => {
  const rounds = new Map([
    ["r1", 0],
    ["r2", 1],
  ])
  const items = [
    { ...row(3), rootRunID: "r2", started: 1 },
    {
      ...row(2),
      rootRunID: "r1",
      started: 8,
      group: { id: "c1", started: 2, memberCount: 2, attemptCount: 1, retryCount: 0, anomalies: 0, purpose: null },
    },
    {
      ...row(1),
      rootRunID: "r1",
      started: 6,
      group: { id: "c2", started: 5, memberCount: 2, attemptCount: 1, retryCount: 0, anomalies: 0, purpose: null },
    },
  ]
  const roundOrder = mergeExecutionWindow([], items, [], { history: false, compare: executionOrder("round", rounds) })
  expect(roundOrder.rows.map((node) => node.id)).toEqual(["1", "2", "3"])
  const callOrder = mergeExecutionWindow([], items, [], { history: false, compare: executionOrder("call", rounds) })
  expect(callOrder.rows.map((node) => node.id)).toEqual(["2", "1", "3"])
})
test("live filtering respects actor, selected rounds and summary search", () => {
  expect(executionWindowMatches(row(1), { sessionID: "root", query: "READ 1" })).toBe(true)
  expect(executionWindowMatches(row(1), { sessionID: "root", runs: new Set(["child:round"]) })).toBe(false)
  expect(executionWindowMatches({ ...row(1), sessionID: "child" }, { sessionID: "root" })).toBe(false)
  expect(executionWindowMatches({ ...row(1), sessionID: "child", kind: "subtask" }, { sessionID: "root" })).toBe(true)
})
test("main-task live updates retain direct delegations and leave nested delegations inside their parent", () => {
  const parents = new Map([
    ["child", "root"],
    ["grandchild", "child"],
  ])
  expect(
    executionWindowMatches({ ...row(1), sessionID: "child", kind: "subtask" }, { sessionID: "root", parents }),
  ).toBe(true)
  expect(
    executionWindowMatches({ ...row(2), sessionID: "grandchild", kind: "subtask" }, { sessionID: "root", parents }),
  ).toBe(false)
  expect(
    executionWindowMatches(
      { ...row(2), sessionID: "grandchild", kind: "subtask" },
      { sessionID: "root", actor: "all", parents },
    ),
  ).toBe(true)
})

import { contextDashboardState } from "../../../src/components/execution/context-dashboard-state"
import { expect, test } from "bun:test"
import type { ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { contextHistoryBars, contextSourceChanges } from "../../../src/components/execution/context-chart-model"
import { mergeContextHistory } from "../../../src/context/execution-context"

const snapshot = (index: number, tokens: number | null, runID = "round-1"): ExecutionContextSnapshot => ({
  sessionID: "session",
  callID: String(index),
  nodeID: "node-" + index,
  runID,
  requestNumber: index + 1,
  roundNumber: 1,
  started: index,
  modelID: "model",
  providerID: "provider",
  status: "completed",
  inputTokens: tokens,
  contextLimit: 100,
  outputTokens: 5,
  cacheHit: 0.5,
  elapsedMs: 10,
  retries: 0,
  compactedBefore: false,
  requestAvailable: true,
  usage:
    tokens === null
      ? null
      : {
          version: 2,
          modelID: "model",
          providerID: "provider",
          totalInput: tokens,
          categories: [
            {
              category: "userMessages",
              precision: "source",
              estimatedTokens: tokens,
              attributedTokens: tokens,
              items: 1,
            },
          ],
          overhead: { attributedTokens: 0 },
          estimator: { kind: "model-tokenizer" },
          reconciliation: { mode: "residual", factor: 1 },
          capturedAt: index,
        },
})
test("history changes retain decreases and missing evidence instead of interpolation", () => {
  const bars = contextHistoryBars(
    [snapshot(4, 30), snapshot(3, null), snapshot(2, 10), snapshot(1, 20)],
    "request",
    true,
  )
  expect(bars[0].gap).toBe(true)
  expect(bars[1].values.find((value) => value.category === "userMessages")?.tokens).toBe(-10)
  expect(bars[2].gap).toBe(true)
  expect(bars[3].gap).toBe(true)
})
test("round history selects the final request without adding prompt totals", () => {
  const bars = contextHistoryBars([snapshot(3, 30, "round-2"), snapshot(2, 25), snapshot(1, 10)], "round", false)
  expect(bars.map((bar) => bar.snapshot.callID)).toEqual(["2", "3"])
  expect(bars.map((bar) => bar.total)).toEqual([25, 30])
})
test("history paging can reach older requests within a bounded window", () => {
  const values = Array.from({ length: 400 }, (_, index) => snapshot(index, 20))
  const latest = mergeContextHistory([], values)
  expect(latest).toHaveLength(300)
  expect(latest[0].callID).toBe("399")
  const earlier = mergeContextHistory(latest, values.slice(0, 100), true)
  expect(earlier).toHaveLength(300)
  expect(earlier.at(-1)?.callID).toBe("0")
  expect(earlier[0].callID).toBe("299")
})
test("incremental history never bridges an unloaded request interval", () => {
  const bars = contextHistoryBars([snapshot(1, 20), snapshot(8, 90)], "request", true)
  expect(bars[1].gap).toBe(true)
  expect(bars[1].total).toBeNull()
})

test("source changes compare adjacent requests without inventing missing categories or crossing sessions", () => {
  const first = snapshot(1, 20)
  const next = snapshot(2, 30)
  expect(contextSourceChanges(next, [next, first])?.get("userMessages")).toEqual({ tokens: 10, items: 0 })
  expect(contextSourceChanges(first, [next, first])).toBeUndefined()
  expect(contextSourceChanges(next, [snapshot(0, 20)])).toBeUndefined()
  expect(contextSourceChanges(next, [{ ...first, sessionID: "different" }])).toBeUndefined()
  expect(contextSourceChanges(next, [{ ...first, usage: null }])).toBeUndefined()
  expect(
    contextSourceChanges(next, [{ ...first, usage: { ...first.usage!, categories: [] } }])?.has("userMessages"),
  ).toBe(false)
  const fewer = snapshot(2, 5)
  expect(contextSourceChanges(fewer, [first])?.get("userMessages")?.tokens).toBe(-15)
  const reconciled = {
    ...next,
    usage: { ...next.usage!, categories: [{ ...next.usage!.categories[0], estimatedTokens: 20 }] },
  }
  expect(contextSourceChanges(reconciled, [first])?.get("userMessages")?.tokens).toBe(0)
})

test("restoring the overview after a viewport remount does not reopen the previous diagnostic node", () => {
  expect(
    contextDashboardState({
      nodeID: "old-node",
      contextDashboard: { records: false, selected: "request", category: "skills", scroll: 600 },
    }),
  ).toMatchObject({ records: false, selected: "request", category: "skills", scroll: 600 })
  expect(contextDashboardState({ nodeID: "linked-node" }).records).toBe(true)
  expect(contextDashboardState({ contextDashboard: { records: true } }).records).toBe(true)
})

test("a diagnostic round does not replace the saved whole-task dashboard scope", () => {
  expect(
    contextDashboardState({ runID: "diagnostic-round", contextDashboard: { runID: "", records: true } }).runID,
  ).toBe("")
  expect(contextDashboardState({ runID: "entry-round" }).runID).toBe("entry-round")
})

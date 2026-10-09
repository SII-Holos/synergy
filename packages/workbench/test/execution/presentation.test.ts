import { expect, test } from "bun:test"
import { ExecutionPresentation } from "../../src/execution/presentation"
import type { RolloutSchema } from "@ericsanchezok/synergy-harness/rollout"
import { RolloutExecution, RolloutAccounting } from "@ericsanchezok/synergy-harness/rollout"

function run(id: string, started: number, ended?: number): RolloutSchema.RunRecord {
  return {
    version: 1,
    id,
    owner: { kind: "session", scopeID: "scope", sessionID: "session" },
    started,
    ended,
    status: ended === undefined ? "running" : "completed",
    recording: ended === undefined ? "partial" : "complete",
  }
}

function interval(started: number, ended?: number): RolloutSchema.ExecutionInterval {
  return {
    version: 1,
    id: crypto.randomUUID(),
    owner: run("a", 0).owner,
    runID: "child",
    segmentID: crypto.randomUUID(),
    branchID: "main",
    clockID: "test",
    started,
    ended,
    status: ended === undefined ? "active" : "closed",
    coverage: "complete",
  }
}
const sample = { clockID: "test", now: 120 }

test("execution elapsed merges overlapping task intervals and excludes gaps between turns", () => {
  expect(RolloutExecution.measure([interval(10, 50), interval(30, 80), interval(100)], sample).elapsedMs).toBe(90)
  expect(RolloutExecution.measure([], sample).elapsedMs).toBe(0)
})

test("a running child keeps execution active after the parent has finished", () => {
  expect(
    RolloutExecution.summarize(
      { roots: [run("parent", 10, 50)], runs: [run("parent", 10, 50), run("child", 30)], intervals: [interval(30)] },
      sample,
    ).status,
  ).toBe("running")
  expect(RolloutExecution.summarize({ roots: [], runs: [], intervals: [] }, sample).status).toBe("unknown")
})

test("terminal execution retains failures and cancellation instead of reporting success", () => {
  const failed = { ...run("failed", 10, 50), status: "failed" as const }
  expect(
    RolloutExecution.summarize({ roots: [failed], runs: [failed, run("ok", 0, 5)], intervals: [] }, sample).status,
  ).toBe("failed")
  const cancelled = { ...run("cancelled", 0, 5), status: "cancelled" as const }
  expect(RolloutExecution.summarize({ roots: [cancelled], runs: [cancelled], intervals: [] }, sample).status).toBe(
    "cancelled",
  )
})

test("cost presentation does not turn an empty API category into a zero fee", () => {
  const accounting = RolloutAccounting.empty()
  accounting.calls = 1
  accounting.attempts = 2
  accounting.unclassifiedEquivalent = { known: 0.044986131, unknown: 1, total: null }
  accounting.costCoverage!.unclassified = {
    attempts: 2,
    unreported: accounting.unclassifiedEquivalent,
    maximum: accounting.unclassifiedEquivalent,
  }
  const cost = ExecutionPresentation.cost(accounting)
  expect(cost.state).toBe("partial")
  expect(cost.estimates).toEqual([
    { basis: "unclassified", currency: "USD", known: 0.044986131, maximum: 0.044986131, unknown: 1 },
  ])
  expect(cost.missing).toBe(1)
})

test("cost presentation separates reported amounts, estimates and subscription equivalents", () => {
  const accounting = RolloutAccounting.empty()
  accounting.reported.currencies = { USD: 0.12, EUR: 0.2 }
  accounting.costCoverage!.api = {
    attempts: 2,
    unreported: { known: 0.03, unknown: 0, total: 0.03 },
    maximum: { known: 0.03, unknown: 0, total: 0.03 },
  }
  accounting.costCoverage!.subscription = {
    attempts: 1,
    unreported: { known: 0.4, unknown: 0, total: 0.4 },
    maximum: { known: 0.4, unknown: 0, total: 0.4 },
  }
  accounting.subscriptionEquivalent = { known: 0.4, unknown: 0, total: 0.4 }
  const cost = ExecutionPresentation.cost(accounting)
  expect(cost.reported).toEqual([
    { currency: "EUR", amount: 0.2 },
    { currency: "USD", amount: 0.12 },
  ])
  expect(cost.estimates[0].known).toBe(0.03)
  expect(cost.equivalent?.known).toBe(0.4)
  expect(cost.state).toBe("mixed")
  expect(ExecutionPresentation.cost(RolloutAccounting.empty()).state).toBe("unrecorded")
  accounting.costCoverage!.local = 1
  accounting.reported.currencies = {}
  accounting.costCoverage!.api.attempts = 0
  expect(ExecutionPresentation.cost(accounting).state).toBe("subscription")
})

test("reported subscription charges retain a separate estimate of all subscription usage", () => {
  const accounting = RolloutAccounting.empty()
  accounting.reported.currencies.USD = 0.2
  accounting.subscriptionEquivalent = { known: 0.4, unknown: 0, total: 0.4 }
  accounting.costCoverage!.subscription.attempts = 1
  expect(ExecutionPresentation.cost(accounting).equivalent?.known).toBe(0.4)
})

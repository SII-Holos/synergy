import { expect, test } from "bun:test"
import { ExecutionPresentation } from "../../src/execution/presentation"
import type { RolloutSchema } from "@ericsanchezok/synergy-harness/rollout"
import { RolloutAccounting } from "@ericsanchezok/synergy-harness/rollout"

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

test("execution elapsed merges overlapping task intervals and excludes gaps between turns", () => {
  expect(ExecutionPresentation.elapsed([run("a", 10, 50), run("b", 30, 80), run("c", 100)], 120)).toBe(90)
  expect(ExecutionPresentation.elapsed([], 120)).toBe(0)
})

test("a running child keeps execution active after the parent has finished", () => {
  expect(ExecutionPresentation.status([run("parent", 10, 50), run("child", 30)])).toBe("running")
  expect(ExecutionPresentation.status([])).toBe("unknown")
})

test("terminal execution retains failures and cancellation instead of reporting success", () => {
  expect(ExecutionPresentation.status([{ ...run("failed", 0, 5), status: "failed" }, run("ok", 0, 5)])).toBe("failed")
  expect(ExecutionPresentation.status([{ ...run("cancelled", 0, 5), status: "cancelled" }])).toBe("cancelled")
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

import { afterEach, expect, test } from "bun:test"
import { StorageBudgets } from "../../src/storage/budgets"
import { ObservabilityConfig } from "../../src/observability/config"

afterEach(() => {
  // Every test here rewrites the process-wide performance config, so the
  // defaults are restored rather than left for the next file.
  ObservabilityConfig.refresh()
})

function refreshStorage(storage: Record<string, number>) {
  ObservabilityConfig.refresh({ observability: { performance: { storage } } })
}

test("a chunk budget can never consume the margin below the worker ceiling", () => {
  refreshStorage({ chunkBudgetMs: 30_000_000, hardCeilingMs: 300_000 })
  const budgets = StorageBudgets.current()
  // The clamp is what makes the invariant structural: a configuration that
  // would let one chunk reach the ceiling is reduced instead of honored.
  expect(budgets.chunkBudgetMs).toBeLessThan(budgets.hardCeilingMs)
  expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
})

test("the default budgets hold the margin the driver relies on", () => {
  const budgets = StorageBudgets.current()
  expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
  // Maintenance shares the ordinary statement budget by default: a chunked
  // maintenance statement must not be given more room than any other statement,
  // because the worker can only run one at a time.
  expect(budgets.chunkBudgetMs).toBeLessThanOrEqual(budgets.hardCeilingMs)
  expect(budgets.probeAttempts).toBeGreaterThan(1)
})

test("raising the ceiling admits a larger chunk budget without breaking the margin", () => {
  refreshStorage({ chunkBudgetMs: 100_000, hardCeilingMs: 1_000_000 })
  const budgets = StorageBudgets.current()
  expect(budgets.chunkBudgetMs).toBe(100_000)
  expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
})

test("a degenerate ceiling still leaves a usable chunk budget below it", () => {
  refreshStorage({ chunkBudgetMs: 900_000, hardCeilingMs: 50_000 })
  const budgets = StorageBudgets.current()
  expect(budgets.chunkBudgetMs).toBeGreaterThan(0)
  expect(budgets.chunkBudgetMs).toBeLessThan(budgets.hardCeilingMs)
  expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
})

import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { afterEach, expect, test } from "bun:test"
import { StorageBudgets } from "../../src/storage/budgets"
import { ObservabilityConfig } from "../../src/observability/config"

afterEach(() =>
  runtime.run(() => {
    // Every test here rewrites the process-wide performance config, so the
    // defaults are restored rather than left for the next file.
    ObservabilityConfig.refresh()
  }),
)

function refreshStorage(storage: Record<string, number>) {
  ObservabilityConfig.refresh({ observability: { performance: { storage } } })
}

test("a chunk budget can never consume the margin below the worker ceiling", () =>
  runtime.run(() => {
    refreshStorage({ chunkBudgetMs: 30_000_000, hardCeilingMs: 300_000 })
    const budgets = StorageBudgets.current()
    // The clamp is what makes the invariant structural: a configuration that
    // would let one chunk reach the ceiling is reduced instead of honored.
    expect(budgets.chunkBudgetMs).toBeLessThan(budgets.hardCeilingMs)
    expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
  }))

test("the default budgets hold the margin the driver relies on", () =>
  runtime.run(() => {
    const budgets = StorageBudgets.current()
    expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
    // Maintenance shares the ordinary statement budget by default: a chunked
    // maintenance statement must not be given more room than any other statement,
    // because the worker can only run one at a time.
    expect(budgets.chunkBudgetMs).toBeLessThanOrEqual(budgets.hardCeilingMs)
    expect(budgets.probeAttempts).toBeGreaterThan(1)
  }))

test("raising the ceiling admits a larger chunk budget without breaking the margin", () =>
  runtime.run(() => {
    refreshStorage({ chunkBudgetMs: 100_000, hardCeilingMs: 1_000_000 })
    const budgets = StorageBudgets.current()
    expect(budgets.chunkBudgetMs).toBe(100_000)
    expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
  }))

test("a degenerate ceiling still leaves a usable chunk budget below it", () =>
  runtime.run(() => {
    refreshStorage({ chunkBudgetMs: 900_000, hardCeilingMs: 50_000 })
    const budgets = StorageBudgets.current()
    expect(budgets.chunkBudgetMs).toBeGreaterThan(0)
    expect(budgets.chunkBudgetMs).toBeLessThan(budgets.hardCeilingMs)
    expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
  }))

test("every budget that can occupy the loop holds the margin, not just the chunk budget", () =>
  runtime.run(() => {
    // The invariant has to hold for *every* allowed single-statement limit. Clamping
    // only the chunk budget would leave an ordinary statement free to outlive the
    // ceiling, which is the same terminal window by a different name.
    refreshStorage({
      requestDeadlineMs: 30_000_000,
      probeTimeoutMs: 30_000_000,
      chunkBudgetMs: 30_000_000,
      hardCeilingMs: 300_000,
    })
    const budgets = StorageBudgets.current()
    for (const budget of [budgets.requestDeadlineMs, budgets.probeTimeoutMs, budgets.chunkBudgetMs])
      expect(budget * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
    expect(budgets.probeAttempts).toBeGreaterThan(1)
    // The ceiling itself is the one budget allowed to reach the ceiling: it is what
    // bounds the statements that cannot be chunked, so it must not be reduced below
    // the value the operator set.
    expect(budgets.engineBudgetMs).toBe(budgets.hardCeilingMs)
  }))

test("a degenerate ceiling still leaves every budget usable and bounded", () =>
  runtime.run(() => {
    refreshStorage({ requestDeadlineMs: 900_000, probeTimeoutMs: 900_000, hardCeilingMs: 50_000 })
    const budgets = StorageBudgets.current()
    for (const budget of [budgets.requestDeadlineMs, budgets.probeTimeoutMs, budgets.chunkBudgetMs])
      expect(budget).toBeGreaterThan(0)
    expect(budgets.requestDeadlineMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
    expect(budgets.probeTimeoutMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
  }))

afterRuntimeTests(() => runtime.close())

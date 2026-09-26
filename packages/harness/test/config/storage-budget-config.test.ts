import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import { Info } from "../../src/config/schema"
import { ObservabilityConfig } from "../../src/observability/config"
import { StorageBudgets } from "../../src/storage/budgets"

// The budget knobs are only configurable if a user can actually write them. The
// `performance.storage` block is `.strict()`, so a field that exists in the
// resolved shape but not in the public schema is rejected outright at load time
// rather than ignored — which is exactly how these five shipped unusable once.
test("the public config schema accepts every storage budget", () =>
  runtime.run(() => {
    const parsed = Info.safeParse({
      observability: {
        performance: {
          storage: {
            requestDeadlineMs: 5_000,
            probeTimeoutMs: 5_000,
            probeAttempts: 2,
            hardCeilingMs: 120_000,
            chunkBudgetMs: 15_000,
          },
        },
      },
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data!.observability!.performance!.storage).toMatchObject({
      requestDeadlineMs: 5_000,
      probeTimeoutMs: 5_000,
      probeAttempts: 2,
      hardCeilingMs: 120_000,
      chunkBudgetMs: 15_000,
    })
  }))

test("the storage budgets stay optional so an existing config keeps loading", () =>
  runtime.run(() => {
    const parsed = Info.safeParse({ observability: { performance: { storage: { retentionBytes: 1024 } } } })
    expect(parsed.success).toBe(true)
    expect(parsed.data!.observability!.performance!.storage).toEqual({ retentionBytes: 1024 })
  }))

test("a budget a user writes reaches the driver through the runtime seam", () =>
  runtime.run(() => {
    const parsed = Info.safeParse({
      observability: { performance: { storage: { hardCeilingMs: 600_000, chunkBudgetMs: 30_000 } } },
    })
    expect(parsed.success).toBe(true)

    ObservabilityConfig.refresh({ observability: parsed.data!.observability })
    try {
      const budgets = StorageBudgets.current()
      // The public value is what the driver applies, and the ceiling margin still
      // holds for a configuration a user chose rather than only for the defaults.
      expect(budgets.hardCeilingMs).toBe(600_000)
      expect(budgets.chunkBudgetMs).toBe(30_000)
      expect(budgets.chunkBudgetMs * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(budgets.hardCeilingMs)
    } finally {
      ObservabilityConfig.refresh()
    }
  }))

afterRuntimeTests(() => runtime.close())

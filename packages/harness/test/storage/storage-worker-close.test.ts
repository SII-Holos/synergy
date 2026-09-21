import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { StorageBudgets } from "../../src/storage/budgets"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"

test("closing a busy worker stops probing without reporting terminal unavailability", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-worker-close-"))
  const driver = await SqliteDriver.open(path.join(root, "agent.sqlite"))
  const unavailable: Error[] = []
  const unsubscribe = driver.onUnavailable((error) => unavailable.push(error))
  const busy = Promise.withResolvers<void>()
  const original = ObservabilityIssues.raise
  using _observation = spyOn(ObservabilityIssues, "raise").mockImplementation((input) => {
    if (input.code === "STORAGE_WORKER_BUSY") busy.resolve()
    return original(input)
  })
  ObservabilityConfig.refresh({
    observability: {
      performance: {
        storage: {
          requestDeadlineMs: 1000,
          probeTimeoutMs: 1000,
          probeAttempts: 1,
          hardCeilingMs: 10000,
          chunkBudgetMs: 50,
        },
      },
    },
  })
  const query = driver
    .query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT count(*) FROM c")
    .catch(() => undefined)
  try {
    await busy.promise
    const started = performance.now()
    await driver.close()
    const elapsed = performance.now() - started
    await query
    expect(elapsed).toBeLessThan(StorageBudgets.current().teardownBudgetMs + 1000)
    expect(unavailable).toEqual([])
  } finally {
    await driver.close()
    await query
    unsubscribe()
    ObservabilityConfig.refresh()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20000)

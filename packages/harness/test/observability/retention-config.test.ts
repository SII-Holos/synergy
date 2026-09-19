import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { ObservabilityConfig } from "../../src/observability/config"

describe("storage retention window config", () => {
  test("the documented 0 disable path passes the user config schema", () => {
    const parsed = Config.ObservabilityConfig.parse({ performance: { storage: { retentionMs: 0 } } })
    expect(parsed.performance?.storage?.retentionMs).toBe(0)
  })

  test("effective() maps 0 to disabled while clamping positive windows", () => {
    const off = ObservabilityConfig.effective({
      observability: { performance: { storage: { retentionMs: 0 } } },
    })
    expect(off.storage.retentionMs).toBe(0)

    const on = ObservabilityConfig.effective({
      observability: { performance: { storage: { retentionMs: 1000 } } },
    })
    expect(on.storage.retentionMs).toBe(60 * 60 * 1000)
  })
})

describe("authoritative retention budget", () => {
  // The authoritative database reached ~74x the observability cap, so a shared
  // value kept retention permanently over budget and made every sweep delete
  // destructively without ever converging.
  test("is not narrowed by the observability byte cap", () => {
    const effective = ObservabilityConfig.effective({
      observability: { maxBytes: 250 * 1024 * 1024, performance: { storage: { retentionBytes: 8 * 1024 ** 3 } } },
    })
    expect(effective.storage.retentionBytes).toBe(8 * 1024 ** 3)
    expect(effective.storage.maxSqliteBytes).toBeLessThanOrEqual(250 * 1024 * 1024)
  })

  test("defaults above the retention window's steady state", () => {
    const effective = ObservabilityConfig.effective({})
    expect(effective.storage.retentionBytes).toBeGreaterThan(7 * 2.5 * 1024 ** 3)
  })

  test("letting the two budgets differ keeps each at its own scope", () => {
    const effective = ObservabilityConfig.effective({
      observability: { maxBytes: 64 * 1024 * 1024, performance: { storage: { maxSqliteBytes: 32 * 1024 * 1024 } } },
    })
    expect(effective.storage.maxSqliteBytes).toBe(32 * 1024 * 1024)
    expect(effective.storage.retentionBytes).toBeGreaterThan(effective.storage.maxSqliteBytes)
  })
})

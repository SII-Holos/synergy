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

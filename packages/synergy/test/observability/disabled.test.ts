import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("observability disabled", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => cleanupObservabilityHomes())

  test("enabled=false drops metrics, issues, and events and freezes dataVersion", async () => {
    ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
    const before = ObservabilityStore.dataVersion()

    ObservabilityMetrics.record({ name: "disabled.metric", value: 1, unit: "count", module: "observability" })
    ObservabilityIssues.raise({
      code: "PERF_DISABLED",
      severity: "warning",
      module: "observability",
      title: "Disabled issue",
      message: "Disabled issue",
    })
    await ObservabilityEvents.emit("disabled.event", {})
    ObservabilityStore.flush()

    expect(ObservabilityStore.dataVersion()).toBe(before)
    expect(ObservabilityStore.queryMetrics({ since: 0, names: ["disabled.metric"] })).toHaveLength(0)
    expect(ObservabilityIssues.list({ module: "observability" })).toHaveLength(0)
    expect(ObservabilityStore.queryEvents({ type: "disabled.event" })).toHaveLength(0)
  })

  test("re-enabling restores recording", () => {
    ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
    ObservabilityMetrics.record({ name: "disabled.metric", value: 1, unit: "count", module: "observability" })
    ObservabilityStore.flush()
    expect(ObservabilityStore.queryMetrics({ since: 0, names: ["disabled.metric"] })).toHaveLength(0)

    ObservabilityConfig.refresh({ observability: { performance: { enabled: true } } })
    ObservabilityMetrics.record({ name: "reenabled.metric", value: 1, unit: "count", module: "observability" })
    ObservabilityStore.flush()
    expect(ObservabilityStore.queryMetrics({ since: 0, names: ["reenabled.metric"] })).toHaveLength(1)
  })
})

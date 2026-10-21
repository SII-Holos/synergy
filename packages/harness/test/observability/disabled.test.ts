import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { clearObservabilityState, resetObservabilityState } from "./fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("observability disabled", () => {
  beforeEach(() => runtime.run(() => resetObservabilityState()))
  afterEach(() => runtime.run(() => clearObservabilityState()))

  test("enabled=false drops metrics, issues, and events and freezes dataVersion", () =>
    runtime.run(async () => {
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
      ObservabilityIssues.observeCondition({
        owner: "control-plane",
        code: "PERF_DISABLED_CONDITION",
        module: "observability",
        title: "Disabled condition",
        severity: "warning",
        state: "active",
        observedValue: 200,
        thresholdValue: 100,
        unit: "bytes",
      })
      await ObservabilityEvents.emit("disabled.event", {})
      ObservabilityStore.flush()

      expect(ObservabilityStore.dataVersion()).toBe(before)
      expect(ObservabilityStore.queryMetrics({ since: 0, names: ["disabled.metric"] })).toHaveLength(0)
      expect(ObservabilityIssues.list({ module: "observability" })).toHaveLength(0)
      expect(ObservabilityStore.queryEvents({ type: "disabled.event" })).toHaveLength(0)
    }))

  test("re-enabling restores recording", () =>
    runtime.run(() => {
      ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
      ObservabilityMetrics.record({ name: "disabled.metric", value: 1, unit: "count", module: "observability" })
      ObservabilityStore.flush()
      expect(ObservabilityStore.queryMetrics({ since: 0, names: ["disabled.metric"] })).toHaveLength(0)

      ObservabilityConfig.refresh({ observability: { performance: { enabled: true } } })
      ObservabilityMetrics.record({ name: "reenabled.metric", value: 1, unit: "count", module: "observability" })
      ObservabilityStore.flush()
      expect(ObservabilityStore.queryMetrics({ since: 0, names: ["reenabled.metric"] })).toHaveLength(1)
    }))

  test("disabling drains accepted conditions and gauges without accepting new disabled observations", () =>
    runtime.run(async () => {
      const input = {
        owner: "control-plane" as const,
        code: "PERF_CONDITION_BEFORE_DISABLE",
        module: "process" as const,
        title: "Pressure before disable",
        severity: "warning" as const,
        state: "active" as const,
        observedValue: 200,
        thresholdValue: 100,
        unit: "bytes" as const,
      }
      for (let index = 0; index < 100; index++) {
        ObservabilityIssues.observeCondition(input)
        ObservabilityMetrics.record({
          name: "storage.queue.depth",
          value: index,
          unit: "count",
          module: "storage",
          labels: { queue: "disable-drain" },
        })
      }
      const dropped = ObservabilityStore.stats().dropped
      ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
      await ObservabilityStore.reconfigure()
      const version = ObservabilityStore.dataVersion()
      ObservabilityIssues.observeCondition(input)
      ObservabilityMetrics.record({
        name: "storage.queue.depth",
        value: 1000,
        unit: "count",
        module: "storage",
        labels: { queue: "disable-drain" },
      })
      ObservabilityStore.flush()
      expect(ObservabilityStore.dataVersion()).toBe(version)
      expect(ObservabilityStore.stats().dropped).toBe(dropped)
      ObservabilityConfig.refresh()
      ObservabilityStore.reconfigure()
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([
        { code: input.code, occurrenceCount: 100, evidence: { firstObservedValue: 200 } },
      ])
      expect(
        ObservabilityStore.queryMetrics({ since: 0, names: ["storage.queue.depth", "storage.queue.depth.peak"] })
          .filter((metric) => JSON.parse(metric.labels_json).queue === "disable-drain")
          .map((metric) => ({ name: metric.name, value: metric.value })),
      ).toEqual([
        { name: "storage.queue.depth", value: 99 },
        { name: "storage.queue.depth.peak", value: 99 },
      ])
    }))

  test("disabling drains a young gauge before its first storage flush", () =>
    runtime.run(async () => {
      ObservabilityMetrics.record({
        name: "storage.queue.depth",
        value: 7,
        unit: "count",
        module: "storage",
        labels: { queue: "first-disable-drain" },
      })
      ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
      await ObservabilityStore.reconfigure()
      ObservabilityConfig.refresh()
      ObservabilityStore.reconfigure()
      expect(
        ObservabilityStore.queryMetrics({ since: 0, names: ["storage.queue.depth", "storage.queue.depth.peak"] })
          .filter((metric) => JSON.parse(metric.labels_json).queue === "first-disable-drain")
          .map((metric) => ({ name: metric.name, value: metric.value })),
      ).toEqual([
        { name: "storage.queue.depth", value: 7 },
        { name: "storage.queue.depth.peak", value: 7 },
      ])
    }))
})

afterRuntimeTests(() => runtime.close())

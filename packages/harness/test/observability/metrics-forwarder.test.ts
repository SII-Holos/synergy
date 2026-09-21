import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"

describe("ObservabilityMetrics forwarder", () => {
  afterEach(() => {
    ObservabilityMetrics.setForwarder(undefined)
    ObservabilityConfig.refresh()
  })

  test("hands the row to the installed forwarder instead of the local store", () => {
    ObservabilityConfig.refresh()
    using inserted = spyOn(ObservabilityStore, "insertMetric")
    const forwarded: Array<{ name: string; value: number; unit: string; labels?: Record<string, unknown> }> = []
    ObservabilityMetrics.setForwarder((input) => forwarded.push(input))

    ObservabilityMetrics.record({
      name: "llm.fetch.headers",
      value: 42,
      unit: "ms",
      module: "llm",
      labels: { provider: "provider", model: "model" },
    })

    expect(forwarded).toEqual([
      expect.objectContaining({
        name: "llm.fetch.headers",
        value: 42,
        unit: "ms",
        module: "llm",
        labels: { provider: "provider", model: "model" },
      }),
    ])
    expect(inserted).not.toHaveBeenCalled()
  })

  test("keeps the local recording path when no forwarder is installed", () => {
    ObservabilityConfig.refresh()
    using inserted = spyOn(ObservabilityStore, "insertMetric")

    ObservabilityMetrics.record({ name: "snapshot.track.duration", value: 7, unit: "ms", module: "session" })

    expect(inserted).toHaveBeenCalledTimes(1)
    const recorded = inserted.mock.calls.map((call) => call[0])
    expect(recorded[0]).toMatchObject({ name: "snapshot.track.duration", value: 7, unit: "ms" })
  })

  test("restores the local path after the forwarder is removed", () => {
    ObservabilityConfig.refresh()
    using inserted = spyOn(ObservabilityStore, "insertMetric")
    ObservabilityMetrics.setForwarder(() => {})

    ObservabilityMetrics.record({ name: "llm.fetch.first_byte", value: 1, unit: "ms", module: "llm" })
    expect(inserted).not.toHaveBeenCalled()

    ObservabilityMetrics.setForwarder(undefined)
    ObservabilityMetrics.record({ name: "llm.fetch.first_byte", value: 1, unit: "ms", module: "llm" })
    expect(inserted).toHaveBeenCalledTimes(1)
  })
})

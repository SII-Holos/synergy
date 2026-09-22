import { afterAll, expect, spyOn, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const row = { name: "llm.fetch.headers", value: 42, unit: "ms" as const, module: "llm" as const }

test(
  "forwards inside the asynchronous owner even when worker storage is disabled",
  runtime.bind(async () => {
    ObservabilityConfig.refresh({ observability: { enabled: false } })
    using inserted = spyOn(ObservabilityStore, "insertMetric")
    const forwarded: unknown[] = []
    try {
      await ObservabilityMetrics.withForwarder(
        (input) => forwarded.push(input),
        async () => {
          await Promise.resolve()
          ObservabilityMetrics.record(row)
        },
      )
      expect(forwarded).toEqual([row])
      expect(inserted).not.toHaveBeenCalled()
    } finally {
      ObservabilityConfig.refresh()
    }
  }),
)

test(
  "concurrent forwarders retain their own rows and restore local recording",
  runtime.bind(async () => {
    const first: unknown[] = []
    const second: unknown[] = []
    const ready = Promise.withResolvers<void>()
    using inserted = spyOn(ObservabilityStore, "insertMetric")
    await Promise.all([
      ObservabilityMetrics.withForwarder(
        (input) => first.push(input),
        async () => {
          await ready.promise
          ObservabilityMetrics.record({ ...row, value: 1 })
        },
      ),
      ObservabilityMetrics.withForwarder(
        (input) => second.push(input),
        async () => {
          ObservabilityMetrics.record({ ...row, value: 2 })
          ready.resolve()
        },
      ),
    ])
    expect(first).toEqual([{ ...row, value: 1 }])
    expect(second).toEqual([{ ...row, value: 2 }])
    expect(inserted).not.toHaveBeenCalled()
    ObservabilityMetrics.record(row)
    expect(inserted).toHaveBeenCalledTimes(1)
  }),
)

test("a forwarder cannot cross Runtime ownership or survive a closed owner", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  const forwarded: unknown[] = []
  using inserted = spyOn(ObservabilityStore, "insertMetric")
  await first.run(() =>
    ObservabilityMetrics.withForwarder(
      (input) => forwarded.push(input),
      async () => {
        second.run(() => ObservabilityMetrics.record({ ...row, value: 2 }))
        expect(inserted).toHaveBeenCalledTimes(1)
        ObservabilityMetrics.record(row)
        await second.close()
        ObservabilityMetrics.record({ ...row, value: 3 })
        await first.close()
        ObservabilityMetrics.record({ ...row, value: 4 })
      },
    ),
  )
  expect(forwarded).toEqual([row, { ...row, value: 3 }])
})

afterAll(() => runtime.close())

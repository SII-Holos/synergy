import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityStore } from "../../src/observability/store"
import { clearObservabilityState, resetObservabilityState } from "./fixture"

test("HTTP status and span status remain distinct and failed requests enter error buckets", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => {
    resetObservabilityState()
    try {
      const span = ObservabilitySpans.start({ name: "http.request", module: "server" })!
      ObservabilitySpans.end(span, { status: "error", attributes: { method: "GET", route: "/audit", status: 500 } })
      const query = { since: Date.now() - 60_000, names: ["http.request.duration"] }
      const metrics = ObservabilityStore.queryMetrics(query)
      const buckets = ObservabilityStore.queryMetricBuckets({ ...query, bucketMs: 60_000 })
      expect(metrics.map((row) => JSON.parse(row.labels_json))).toEqual([
        { method: "GET", route: "/audit", status: 500, spanStatus: "error" },
      ])
      expect(buckets.reduce((sum, bucket) => sum + bucket.errors, 0)).toBe(1)
    } finally {
      clearObservabilityState()
    }
  })
})

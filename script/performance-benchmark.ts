#!/usr/bin/env bun

import { ObservabilityRedaction } from "../packages/synergy/src/observability/redaction"
import { PerformanceTimeline } from "../packages/synergy/src/performance/timeline"

const iterations = Number(process.env.SYNERGY_BENCH_ITERATIONS ?? 20_000)

type Bench = { name: string; fn: () => void }

const benches: Bench[] = [
  {
    name: "redact.record",
    fn: () => {
      ObservabilityRedaction.record({
        route: "/session/index",
        token: "secret",
        prompt: "must not leak",
        module: "server",
      })
    },
  },
  {
    name: "timeline.allowedMetricLookup",
    fn: () => {
      for (const metric of PerformanceTimeline.allowedMetricNames.slice(0, 8)) {
        if (!PerformanceTimeline.allowedMetricNames.includes(metric)) throw new Error(metric)
      }
    },
  },
]

const results = benches.map((bench) => {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) bench.fn()
  const durationMs = performance.now() - start
  return { name: bench.name, iterations, durationMs, opsPerSecond: Math.round((iterations / durationMs) * 1000) }
})

console.log(
  JSON.stringify({ harness: "bun-microbench", compatibleWith: "mitata-style ops/sec reporting", results }, null, 2),
)

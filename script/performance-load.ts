#!/usr/bin/env bun

const baseUrl = process.env.SYNERGY_PERF_BASE_URL ?? "http://127.0.0.1:5817"
const durationMs = Number(process.env.SYNERGY_PERF_DURATION_MS ?? 30_000)
const concurrency = Number(process.env.SYNERGY_PERF_CONCURRENCY ?? 8)
const path = process.env.SYNERGY_PERF_PATH ?? "/global/health"

const deadline = Date.now() + durationMs
let completed = 0
let failed = 0
const latencies: number[] = []

async function worker() {
  while (Date.now() < deadline) {
    const start = performance.now()
    try {
      const response = await fetch(`${baseUrl}${path}`)
      if (!response.ok) failed++
      await response.arrayBuffer()
    } catch {
      failed++
    } finally {
      latencies.push(performance.now() - start)
      completed++
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker))
latencies.sort((a, b) => a - b)
const percentile = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))] ?? 0

console.log(
  JSON.stringify(
    {
      baseUrl,
      path,
      durationMs,
      concurrency,
      completed,
      failed,
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      p99Ms: percentile(99),
      rps: completed / (durationMs / 1000),
    },
    null,
    2,
  ),
)

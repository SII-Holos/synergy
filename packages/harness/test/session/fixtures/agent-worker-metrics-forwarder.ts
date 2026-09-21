// Drives the real Agent worker runner entrypoint in a child process so the
// process-global metric forwarder is exercised exactly as a spawned worker
// installs it. The parent observes the frames over the IPC channel.
const runner = await import("../../../src/session/agent-turn/runner")
const { ObservabilityMetrics } = await import("../../../src/observability/metrics")

const burst = Number(process.env.SYNERGY_METRIC_BURST ?? "1")

// Let the parent attach to the channel, then record one synchronous burst so
// the coalescer has to bound both the frame size and the pending queue.
await Bun.sleep(50)
for (let index = 0; index < burst; index++) {
  ObservabilityMetrics.record({
    name: index % 2 === 0 ? "llm.fetch.headers" : "llm.fetch.first_byte",
    value: index,
    unit: "ms",
    module: "llm",
    labels: { provider: "provider", model: "model" },
  })
}
await Bun.sleep(200)
console.log(JSON.stringify({ dropped: runner.droppedMetricRows() }))
process.exit(0)

import { RuntimeContext } from "../../../src/lifecycle/context"
import { ObservabilityMetrics } from "../../../src/observability/metrics"
import { createTurnMetrics } from "../../../src/session/agent-turn/metrics"
import { runtimeHome } from "../../support/runtime-home"

await using fixture = await runtimeHome()
const runtime = RuntimeContext.create(fixture.host)
try {
  await runtime.run(async () => {
    const burst = Number(process.env.SYNERGY_METRIC_BURST ?? "1")
    const expected = Math.ceil(Math.min(burst, 256) / 64)
    const drained = Promise.withResolvers<void>()
    let acknowledgements = 0
    process.on("message", () => {
      if (++acknowledgements === expected) drained.resolve()
    })
    const metrics = createTurnMetrics("fixture-turn", (frame) => process.send?.(frame))
    ObservabilityMetrics.withForwarder(metrics.record, () => {
      for (let index = 0; index < burst; index++) {
        ObservabilityMetrics.record({
          name: index % 2 === 0 ? "llm.fetch.headers" : "llm.fetch.first_byte",
          value: index,
          unit: "ms",
          module: "llm",
          labels: { provider: "provider", model: "model" },
        })
      }
    })
    metrics.close()
    await drained.promise
    console.log(JSON.stringify({ dropped: metrics.dropped }))
  })
} finally {
  runtime.dispose()
}
process.disconnect?.()

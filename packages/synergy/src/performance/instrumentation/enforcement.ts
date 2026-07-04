import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace EnforcementPerformanceInstrumentation {
  export const startDecisionSpan = (input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("enforcement", "enforcement.decision", input)

  export const endDecisionSpan = PerformanceSpans.end

  export function recordDecisionDuration(durationMs: number, decision: string) {
    recordMetric("enforcement", "enforcement.decision.duration", durationMs, "ms", { labels: { decision } })
  }
}

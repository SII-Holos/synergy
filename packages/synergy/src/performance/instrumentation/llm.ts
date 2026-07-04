import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace LlmPerformanceInstrumentation {
  export const startCallSpan = (input: Parameters<typeof startSpan>[2] = {}) => startSpan("llm", "llm.call", input)

  export const endCallSpan = PerformanceSpans.end

  export function recordTokenCount(count: number, labels: Record<string, unknown> = {}) {
    recordMetric("llm", "llm.tokens", count, "tokens", { labels })
  }
}

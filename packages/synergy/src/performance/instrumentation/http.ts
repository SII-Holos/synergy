import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace HttpPerformanceInstrumentation {
  export const startRequestSpan = (input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("server", "http.request", input)

  export const endRequestSpan = PerformanceSpans.end

  export function recordRequestDuration(durationMs: number, labels: Record<string, unknown>, rid?: string) {
    recordMetric("server", "http.request.duration", durationMs, "ms", { labels, rid })
  }
}

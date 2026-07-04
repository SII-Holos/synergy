import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace SsePerformanceInstrumentation {
  export const startConnectionSpan = (input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("server", "sse.connection", input)

  export const endConnectionSpan = PerformanceSpans.end

  export function recordWrite(status: string) {
    recordMetric("server", "sse.write.count", 1, "count", { labels: { status } })
  }
}

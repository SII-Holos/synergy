import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace ObservabilityPerformanceInstrumentation {
  export const startFlushSpan = (input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("observability", "observability.writer.flush", input)

  export const endFlushSpan = PerformanceSpans.end

  export function recordQueueDepth(depth: number) {
    recordMetric("observability", "observability.writer.queue_depth", depth, "count")
  }
}

import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace LibraryPerformanceInstrumentation {
  export const startQuerySpan = (operation: string, input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("library", "library.query", { ...input, attributes: { operation } })

  export const endQuerySpan = PerformanceSpans.end

  export function recordQueryDuration(durationMs: number, operation: string) {
    recordMetric("library", "library.operation.duration", durationMs, "ms", { labels: { operation } })
  }
}

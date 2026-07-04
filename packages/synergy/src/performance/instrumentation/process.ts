import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace ProcessPerformanceInstrumentation {
  export const startProcessSpan = (processId: string, input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("process", "process.lifecycle", { ...input, source: "process", processId })

  export const endProcessSpan = PerformanceSpans.end

  export function recordActiveProcesses(count: number) {
    recordMetric("process", "process.active", count, "count", { labels: {} })
  }
}

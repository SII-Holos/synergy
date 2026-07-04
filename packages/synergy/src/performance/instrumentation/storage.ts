import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace StoragePerformanceInstrumentation {
  export const startOperationSpan = (operation: string, input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("storage", "storage.operation", { ...input, attributes: { operation } })

  export const endOperationSpan = PerformanceSpans.end

  export function recordOperationCount(operation: string, status: string) {
    recordMetric("storage", "storage.operation.count", 1, "count", { labels: { operation, status } })
  }
}

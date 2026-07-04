import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace ToolPerformanceInstrumentation {
  export const startExecutionSpan = (tool: string, input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("tool", "tool.execution", { ...input, tool })

  export const endExecutionSpan = PerformanceSpans.end

  export function recordToolCall(tool: string, status: string, sessionID?: string) {
    recordMetric("tool", "tool.call.count", 1, "count", { sessionID, tool, labels: { status } })
  }
}

import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace PtyPerformanceInstrumentation {
  export const startPtySpan = (processId: string, input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("pty", "pty.session", { ...input, source: "process", processId })

  export const endPtySpan = PerformanceSpans.end

  export function recordThroughput(bytes: number, direction: "input" | "output", processId?: string) {
    recordMetric("pty", "pty.data.bytes", bytes, "bytes", { processId, labels: { direction } })
  }
}

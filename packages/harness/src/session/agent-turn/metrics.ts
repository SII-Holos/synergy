import { AgentTurnProtocol } from "./protocol"
import type { ObservabilityMetrics } from "../../observability/metrics"

type MetricFrame = Extract<AgentTurnProtocol.WorkerToHost, { type: "metrics" }>

export function createTurnMetrics(requestId: string, send: (frame: MetricFrame) => void) {
  const rows: AgentTurnProtocol.MetricRow[] = []
  const maxQueued = AgentTurnProtocol.METRIC_ROWS_MAX * 4
  let scheduled = false
  let closed = false
  let dropped = 0

  function flush() {
    scheduled = false
    while (rows.length > 0) {
      const batch = rows.splice(0, AgentTurnProtocol.METRIC_ROWS_MAX)
      try {
        const frame: MetricFrame = { type: "metrics", requestId, rows: batch }
        AgentTurnProtocol.assertIpcFrameBound(frame)
        send(frame)
      } catch {
        dropped += batch.length
      }
    }
  }

  return {
    record(input: Parameters<typeof ObservabilityMetrics.record>[0]) {
      if (closed || rows.length >= maxQueued) {
        dropped++
        return
      }
      const parsed = AgentTurnProtocol.MetricRow.safeParse({
        value: input.value,
        unit: input.unit,
        module: input.module,
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        traceId: input.traceId,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        sampleRate: input.sampleRate,
        name: input.name.slice(0, AgentTurnProtocol.METRIC_STRING_MAX_CHARS),
        labels: metricLabels(input.labels),
      })
      if (!parsed.success) {
        dropped++
        return
      }
      rows.push(parsed.data)
      if (scheduled) return
      scheduled = true
      queueMicrotask(flush)
    },
    close() {
      closed = true
      flush()
    },
    get dropped() {
      return dropped
    },
  }
}

function metricLabels(input: Record<string, unknown> | undefined) {
  const labels: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (Object.keys(labels).length >= AgentTurnProtocol.METRIC_LABEL_KEYS_MAX) break
    if (typeof value === "string") labels[key] = value.slice(0, AgentTurnProtocol.METRIC_LABEL_VALUE_MAX_CHARS)
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || value === null) {
      labels[key] = value
    }
  }
  return labels
}

import { PerformanceMetrics } from "../metrics"
import { PerformanceSchema } from "../schema"
import { PerformanceSpans } from "../spans"

export interface InstrumentationAttributes {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  scopeID?: string
  sessionID?: string
  messageID?: string
  callID?: string
  rid?: string
  processId?: string
  pid?: number
  tool?: string
  source?: PerformanceSchema.Source
  labels?: Record<string, unknown>
}

export function recordMetric(
  module: PerformanceSchema.Module,
  name: string,
  value: number,
  unit: PerformanceSchema.Unit,
  attrs: InstrumentationAttributes = {},
) {
  PerformanceMetrics.record({ module, name, value, unit, ...attrs })
}

export function startSpan(
  module: PerformanceSchema.Module,
  name: string,
  attrs: InstrumentationAttributes & { source?: PerformanceSchema.Source; attributes?: Record<string, unknown> } = {},
) {
  return PerformanceSpans.start({ module, name, ...attrs })
}

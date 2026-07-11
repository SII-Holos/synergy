import { ObservabilityClock } from "./clock"
import { ObservabilityContext } from "./context"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"
import { parseJson } from "@/util/json-parse"

export namespace ObservabilityEvents {
  export async function emit(
    type: string,
    input: Omit<Partial<ObservabilitySchema.Event>, "type" | "time" | "iso" | "eventId" | "data" | "redaction"> & {
      data?: Record<string, unknown>
    } = {},
  ) {
    const context = ObservabilityContext.merge({
      correlationId: input.correlationId,
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      tool: input.tool,
      processId: input.processId,
      pid: input.pid,
      scopeID: input.scopeID,
      rid: input.rid,
      source: input.source ?? "backend",
      module: input.module ?? "observability",
    })
    const redacted = ObservabilityRedaction.redactRecord(input.data)
    const time = ObservabilityClock.now()
    const event: ObservabilitySchema.Event = {
      eventId: ObservabilityClock.id("evt"),
      time,
      iso: ObservabilityClock.iso(time),
      type,
      level: input.level,
      cwd: input.cwd ? ObservabilityRedaction.cwdScope(input.cwd) : undefined,
      source: context.source ?? "backend",
      module: context.module ?? "observability",
      correlationId: context.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      tool: context.tool,
      processId: context.processId,
      pid: context.pid,
      scopeID: context.scopeID,
      rid: context.rid,
      data: redacted.value,
      redaction: redacted.summary,
    }
    ObservabilityStore.insertEvent(event)
    return event
  }

  export function fromRow(row: ObservabilityStore.StoredEvent): ObservabilitySchema.Event {
    return ObservabilitySchema.Event.parse({
      eventId: row.event_id,
      time: row.time,
      iso: row.iso,
      type: row.type,
      level: row.level ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      traceId: row.trace_id ?? undefined,
      spanId: row.span_id ?? undefined,
      parentSpanId: row.parent_span_id ?? undefined,
      sessionID: row.session_id ?? undefined,
      messageID: row.message_id ?? undefined,
      callID: row.call_id ?? undefined,
      tool: row.tool ?? undefined,
      processId: row.process_id ?? undefined,
      pid: row.pid ?? undefined,
      cwd: row.cwd ?? undefined,
      scopeID: row.scope_id ?? undefined,
      rid: row.rid ?? undefined,
      source: row.source,
      module: row.module,
      data: parseJson(row.data_json),
      redaction: parseRedaction(row.redaction_json),
    })
  }

  function parseRedaction(text: string | null | undefined): ObservabilitySchema.RedactionSummary {
    const parsed = text ? parseJson(text) : {}
    return ObservabilitySchema.RedactionSummary.parse({ applied: true, omittedKeys: 0, truncatedValues: 0, ...parsed })
  }
}

import { ObservabilityEvents } from "@/observability/events"
import { ObservabilityIssues } from "@/observability/issues"
import { ObservabilityStore } from "@/observability/store"
import { SessionMessageCache } from "./message-cache"
import { LLMTurnMemory } from "./llm-memory"
import { SessionMemoryPressure } from "./memory-pressure"

export namespace SessionMemoryIncident {
  const PROCESS_STARTED_AT = Date.now()
  const DEDUPE_MS = 5_000
  let lastCapturedAt = 0

  interface ResourceView {
    time: number
    rssBytes?: number
    heapUsedBytes?: number
    heapTotalBytes?: number
    externalBytes?: number
    arrayBuffersBytes?: number
  }

  interface SpanView {
    name: string
    kind?: string
    module?: string
    ageMs: number
    idleMs?: number
    stalled?: boolean
    tool?: string
  }

  interface CacheView {
    totalBytes: number
    entryCount: number
    activeCount: number
    hits: number
    misses: number
    evictions: number
    protectedOverbudget: number
    entries: Array<{ estimatedBytes: number }>
  }

  interface TurnView {
    ageMs: number
    streamActive?: boolean
    providerID?: string
    modelID?: string
    historyBeforeBytes?: number
    historyAfterBytes?: number
    requestBytes?: number
    toolSchemaBytes?: number
    outputChars?: number
    toolRawChars?: number
    memoryDelta?: Partial<SessionMemoryPressure.Snapshot>
  }

  export function isOutOfMemory(error: unknown) {
    return error instanceof Error && /out of memory/i.test(error.message)
  }

  export function build(input: {
    occurredAt: number
    current: SessionMemoryPressure.Snapshot
    gc: unknown
    resources: ResourceView[]
    spans: SpanView[]
    cache: CacheView
    turns: TurnView[]
  }) {
    return {
      occurredAt: input.occurredAt,
      current: input.current,
      gc: input.gc,
      resources: input.resources.slice(-6),
      spans: input.spans.slice(0, 20),
      cache: { ...input.cache, entries: input.cache.entries.slice(0, 20) },
      turns: input.turns.slice(0, 20),
    }
  }

  export async function capture(input: { error: unknown; sessionID?: string; messageID?: string; now?: number }) {
    if (!isOutOfMemory(input.error)) return undefined
    const now = input.now ?? Date.now()
    if (lastCapturedAt > 0 && now - lastCapturedAt < DEDUPE_MS) return undefined
    lastCapturedAt = now

    const gc = await SessionMemoryPressure.maybeCollect({
      sessionID: input.sessionID,
      messageID: input.messageID,
      phase: "oom.incident",
    })
    const resources = ObservabilityStore.resourceSince(now - 30_000, { limit: 64, newestFirst: true })
      .filter((row) => row.process_role === "server")
      .reverse()
      .map((row) => ({
        time: row.time,
        rssBytes: row.memory_rss_bytes ?? undefined,
        heapUsedBytes: row.memory_heap_used_bytes ?? undefined,
        heapTotalBytes: row.memory_heap_total_bytes ?? undefined,
        externalBytes: row.memory_external_bytes ?? undefined,
        arrayBuffersBytes: row.memory_array_buffers_bytes ?? undefined,
      }))
    const spans = ObservabilityStore.querySpans({
      since: PROCESS_STARTED_AT,
      status: "running",
      limit: 40,
    }).map((row) => ({
      name: row.name,
      kind: row.kind ?? undefined,
      module: row.module,
      ageMs: Math.max(0, now - row.start_time),
      idleMs: Math.max(0, now - (row.last_activity_time ?? row.start_time)),
      stalled: Boolean(row.stalled),
      tool: row.tool ?? undefined,
    }))
    const cacheStats = SessionMessageCache.stats()
    const incident = build({
      occurredAt: now,
      current: gc.before,
      gc,
      resources,
      spans,
      cache: {
        totalBytes: cacheStats.totalBytes,
        entryCount: cacheStats.entryCount,
        activeCount: cacheStats.activeCount,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        evictions: cacheStats.evictions,
        protectedOverbudget: cacheStats.protectedOverbudget,
        entries: cacheStats.entries.map((entry) => ({ estimatedBytes: entry.estimatedBytes })),
      },
      turns: LLMTurnMemory.incidentSnapshot(20).map((turn) => ({
        ageMs: turn.ageMs,
        streamActive: turn.streamActive,
        providerID: turn.providerID,
        modelID: turn.modelID,
        historyBeforeBytes: turn.historyBeforeBytes,
        historyAfterBytes: turn.historyAfterBytes,
        requestBytes: turn.requestBytes,
        toolSchemaBytes: turn.toolSchemaBytes,
        outputChars: turn.outputChars,
        toolRawChars: turn.toolRawChars,
        memoryDelta: turn.memoryDelta,
      })),
    })
    await ObservabilityEvents.emit("process.memory.oom_incident", {
      module: "process",
      source: "process",
      level: "error",
      sessionID: input.sessionID,
      messageID: input.messageID,
      data: incident,
    })
    ObservabilityIssues.raise({
      code: "PERF_PROCESS_OUT_OF_MEMORY",
      severity: "critical",
      module: "process",
      title: "Process allocation failed",
      message: "The runtime reported an out-of-memory allocation failure.",
      recommendation:
        "Inspect the bounded OOM incident, active LLM turns, cache footprint, and memory-category trends.",
      sessionID: input.sessionID,
      messageID: input.messageID,
      evidence: {
        heapUsedBytes: incident.current.heapUsedBytes,
        externalBytes: incident.current.externalBytes,
        arrayBuffersBytes: incident.current.arrayBuffersBytes,
        activeTurnCount: incident.turns.length,
        cacheBytes: incident.cache.totalBytes,
      },
    })
    return incident
  }

  export function resetForTest() {
    lastCapturedAt = 0
  }
}

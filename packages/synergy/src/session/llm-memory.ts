import { ObservabilityEvents } from "@/observability/events"
import { ObservabilityMetrics } from "@/observability/metrics"
import { SessionMemoryPressure } from "./memory-pressure"

export namespace LLMTurnMemory {
  const CHECKPOINT_INTERVAL_MS = 5_000
  const ESTIMATE_LIMIT_BYTES = 256 * 1024 * 1024

  type Snapshot = SessionMemoryPressure.Snapshot
  type Phase =
    | "history.before_projection"
    | "history.after_projection"
    | "request.prepared"
    | "stream.started"
    | "stream.periodic"
    | "tool.input"
    | "stream.disposed"
    | "turn.released"

  interface Entry {
    id: string
    sessionID: string
    messageID: string
    providerID: string
    modelID: string
    startedAt: number
    baseline: Snapshot
    latest: Snapshot
    historyBeforeBytes: number
    historyAfterBytes: number
    requestBytes: number
    toolSchemaBytes: number
    outputChars: number
    toolRawChars: number
    toolRawByCall: Map<string, number>
    lastToolCheckpointChars: number
    lastToolCheckpointAt: number
    streamActive: boolean
    pressurePending: boolean
    timer?: Timer
  }

  export interface Handle extends Disposable {
    stabilizeBeforeProjection(): Promise<void>
    projected(input: { historyAfterBytes: number }): void
    prepared(input: { requestBytes: number; toolSchemaBytes: number }): void
    streamStarted(): void
    addOutputChars(chars: number): void
    observeToolRawChars(callID: string, chars: number): void
    streamDisposed(): void
    release(): void
  }

  const active = new Map<string, Entry>()
  const recent: ReturnType<typeof snapshotEntry>[] = []
  let snapshotForTest: (() => Snapshot) | undefined

  export function begin(input: {
    sessionID: string
    messageID: string
    providerID: string
    modelID: string
    historyBeforeBytes: number
    baseline?: Snapshot
  }): Handle {
    const id = `${input.sessionID}:${input.messageID}`
    active.get(id)?.timer && clearInterval(active.get(id)!.timer)
    const baseline = input.baseline ?? currentSnapshot()
    const entry: Entry = {
      ...input,
      id,
      startedAt: Date.now(),
      baseline,
      latest: baseline,
      historyBeforeBytes: finite(input.historyBeforeBytes),
      historyAfterBytes: 0,
      requestBytes: 0,
      toolSchemaBytes: 0,
      outputChars: 0,
      toolRawChars: 0,
      toolRawByCall: new Map(),
      lastToolCheckpointChars: 0,
      lastToolCheckpointAt: 0,
      streamActive: false,
      pressurePending: false,
    }
    active.set(id, entry)
    checkpoint(entry, "history.before_projection", baseline)
    let released = false
    const handle: Handle = {
      async stabilizeBeforeProjection() {
        if (released) return
        await checkPressure(entry, "history.before_projection")
      },
      projected(value) {
        if (released) return
        entry.historyAfterBytes = finite(value.historyAfterBytes)
        checkpoint(entry, "history.after_projection")
      },
      prepared(value) {
        if (released) return
        entry.requestBytes = finite(value.requestBytes)
        entry.toolSchemaBytes = finite(value.toolSchemaBytes)
        checkpoint(entry, "request.prepared")
      },
      streamStarted() {
        if (released || entry.streamActive) return
        entry.streamActive = true
        SessionMemoryPressure.streamStarted()
        checkpoint(entry, "stream.started")
        entry.timer = setInterval(() => checkpoint(entry, "stream.periodic"), CHECKPOINT_INTERVAL_MS)
        entry.timer.unref()
      },
      addOutputChars(chars) {
        if (released) return
        entry.outputChars += finite(chars)
      },
      observeToolRawChars(callID, chars) {
        if (released) return
        const observed = finite(chars)
        const previous = entry.toolRawByCall.get(callID) ?? 0
        if (observed > previous) {
          entry.toolRawByCall.set(callID, observed)
          entry.toolRawChars += observed - previous
        }
        const now = Date.now()
        if (
          entry.toolRawChars - entry.lastToolCheckpointChars >= 64 * 1024 ||
          now - entry.lastToolCheckpointAt >= CHECKPOINT_INTERVAL_MS
        ) {
          entry.lastToolCheckpointChars = entry.toolRawChars
          entry.lastToolCheckpointAt = now
          checkpoint(entry, "tool.input")
        }
      },
      streamDisposed() {
        if (released || !entry.streamActive) return
        entry.streamActive = false
        SessionMemoryPressure.streamDisposed()
        if (entry.timer) clearInterval(entry.timer)
        entry.timer = undefined
        checkpoint(entry, "stream.disposed")
      },
      release() {
        if (released) return
        released = true
        if (entry.streamActive) SessionMemoryPressure.streamDisposed()
        if (entry.timer) clearInterval(entry.timer)
        entry.timer = undefined
        entry.streamActive = false
        checkpoint(entry, "turn.released")
        recent.unshift(snapshotEntry(entry))
        recent.length = Math.min(recent.length, 20)
        active.delete(id)
      },
      [Symbol.dispose]() {
        handle.release()
      },
    }
    return handle
  }

  export function stats() {
    return {
      activeTurnCount: active.size,
      activeStreamCount: [...active.values()].filter((entry) => entry.streamActive).length,
    }
  }

  export function activeSnapshot(limit = 20) {
    const activeStreamCount = stats().activeStreamCount
    return [...active.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(0, limit))
      .map((entry) => snapshotEntry(entry, activeStreamCount))
  }

  export function incidentSnapshot(limit = 20) {
    return [...activeSnapshot(limit), ...recent].slice(0, Math.max(0, limit))
  }

  export function estimateBytes(value: unknown, limit = ESTIMATE_LIMIT_BYTES) {
    return estimate(value, limit, (text) => Buffer.byteLength(text, "utf8"))
  }

  export function estimateChars(value: unknown, limit = ESTIMATE_LIMIT_BYTES) {
    return estimate(value, limit, (text) => text.length)
  }

  function estimate(value: unknown, limit: number, stringLength: (value: string) => number) {
    const seen = new WeakSet<object>()
    let total = 0
    const stack: unknown[] = [value]
    while (stack.length > 0 && total < limit) {
      const item = stack.pop()
      if (item === null) {
        total += 4
        continue
      }
      switch (typeof item) {
        case "string":
          total += stringLength(item) + 2
          break
        case "number":
          total += Number.isFinite(item) ? String(item).length : 4
          break
        case "boolean":
          total += item ? 4 : 5
          break
        case "bigint":
          total += item.toString().length
          break
        case "object": {
          if (seen.has(item)) {
            total += 4
            break
          }
          seen.add(item)
          if (Array.isArray(item)) {
            total += 2 + Math.max(0, item.length - 1)
            for (const child of item) stack.push(child)
            break
          }
          const entries = Object.entries(item)
          total += 2 + Math.max(0, entries.length - 1)
          for (const [key, child] of entries) {
            if (child === undefined || typeof child === "function" || typeof child === "symbol") continue
            total += stringLength(key) + 3
            stack.push(child)
          }
          break
        }
      }
    }
    return Math.min(total, limit)
  }

  export function setSnapshotForTest(snapshot: (() => Snapshot) | undefined) {
    snapshotForTest = snapshot
  }

  export function resetForTest() {
    for (const entry of active.values()) {
      if (entry.timer) clearInterval(entry.timer)
      if (entry.streamActive) SessionMemoryPressure.streamDisposed()
    }
    active.clear()
    recent.length = 0
    snapshotForTest = undefined
  }

  function checkpoint(entry: Entry, phase: Phase, observed = currentSnapshot()) {
    entry.latest = observed
    const memoryDelta = delta(entry.baseline, entry.latest)
    const activeStreamCount = stats().activeStreamCount
    const data = {
      phase,
      ageMs: Math.max(0, Date.now() - entry.startedAt),
      activeStreamCount,
      historyBeforeBytes: entry.historyBeforeBytes,
      historyAfterBytes: entry.historyAfterBytes,
      requestBytes: entry.requestBytes,
      toolSchemaBytes: entry.toolSchemaBytes,
      outputChars: entry.outputChars,
      toolRawChars: entry.toolRawChars,
      memory: entry.latest,
      memoryDelta,
    }
    void ObservabilityEvents.emit("llm.turn.memory.checkpoint", {
      module: "llm",
      sessionID: entry.sessionID,
      messageID: entry.messageID,
      data,
    })
    for (const [name, value] of Object.entries({
      "llm.turn.history.before_bytes": entry.historyBeforeBytes,
      "llm.turn.history.after_bytes": entry.historyAfterBytes,
      "llm.turn.request.bytes": entry.requestBytes,
      "llm.turn.tool_schema.bytes": entry.toolSchemaBytes,
      "llm.turn.output_chars": entry.outputChars,
      "llm.turn.tool_raw_chars": entry.toolRawChars,
      "llm.turn.active_streams": activeStreamCount,
      "llm.turn.memory.heap_used_delta": memoryDelta.heapUsedBytes,
      "llm.turn.memory.external_delta": memoryDelta.externalBytes,
      "llm.turn.memory.array_buffers_delta": memoryDelta.arrayBuffersBytes,
    })) {
      ObservabilityMetrics.record({
        name,
        value,
        unit: name.endsWith("chars") || name.endsWith("streams") ? "count" : "bytes",
        module: "llm",
        sessionID: entry.sessionID,
        messageID: entry.messageID,
        labels: { phase, providerID: entry.providerID, modelID: entry.modelID },
      })
    }
    if (phase !== "history.before_projection" && phase !== "stream.disposed" && phase !== "turn.released")
      void checkPressure(entry, phase)
  }

  async function checkPressure(entry: Entry, phase: Phase) {
    if (entry.pressurePending) return
    const thresholds = SessionMemoryPressure.resolveThresholds(process.env, entry.latest)
    if (SessionMemoryPressure.pressureLevel(entry.latest, thresholds) === "normal") return
    entry.pressurePending = true
    try {
      await SessionMemoryPressure.maybeCollect({
        sessionID: entry.sessionID,
        messageID: entry.messageID,
        phase: `llm.turn.${phase}`,
      })
    } catch {
      return
    } finally {
      entry.pressurePending = false
    }
  }

  function currentSnapshot() {
    return snapshotForTest?.() ?? SessionMemoryPressure.currentSnapshot()
  }

  function snapshotEntry(entry: Entry, activeStreamCount = 0) {
    return {
      sessionID: entry.sessionID,
      messageID: entry.messageID,
      providerID: entry.providerID,
      modelID: entry.modelID,
      startedAt: entry.startedAt,
      ageMs: Math.max(0, Date.now() - entry.startedAt),
      streamActive: entry.streamActive,
      activeStreamCount,
      historyBeforeBytes: entry.historyBeforeBytes,
      historyAfterBytes: entry.historyAfterBytes,
      requestBytes: entry.requestBytes,
      toolSchemaBytes: entry.toolSchemaBytes,
      outputChars: entry.outputChars,
      toolRawChars: entry.toolRawChars,
      memory: entry.latest,
      memoryDelta: delta(entry.baseline, entry.latest),
    }
  }

  function delta(start: Snapshot, current: Snapshot): Snapshot {
    return {
      rssBytes: current.rssBytes - start.rssBytes,
      heapUsedBytes: current.heapUsedBytes - start.heapUsedBytes,
      heapTotalBytes: current.heapTotalBytes - start.heapTotalBytes,
      externalBytes: current.externalBytes - start.externalBytes,
      arrayBuffersBytes: current.arrayBuffersBytes - start.arrayBuffersBytes,
      ...(current.cgroupCurrentBytes === undefined || start.cgroupCurrentBytes === undefined
        ? {}
        : { cgroupCurrentBytes: current.cgroupCurrentBytes - start.cgroupCurrentBytes }),
      ...(current.cgroupWorkingSetBytes === undefined || start.cgroupWorkingSetBytes === undefined
        ? {}
        : { cgroupWorkingSetBytes: current.cgroupWorkingSetBytes - start.cgroupWorkingSetBytes }),
    }
  }

  function finite(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  }
}

export type EventQueueOptions = {
  emit: (directory: string, payload: unknown) => void
  isHidden: () => boolean
  batch: <T>(fn: () => T) => T
  schedule?: (fn: () => void, ms: number) => void
  now?: () => number
}

export type EventQueue = {
  push: (directory: string, payload: unknown) => void
  flush: () => void
  dispose: () => void
}

export const EVENT_QUEUE_CAP = 4000
export const VISIBLE_FLUSH_MS = 16
export const HIDDEN_FLUSH_MS = 1000

type Queued = { directory: string; payload: unknown }

type PendingDelta = {
  directory: string
  sessionID: string
  messageID: string
  partID: string
  kind: string
  delta: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function eventKey(directory: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) return
  const type = payload.type
  const properties = payload.properties
  if (type === "session.status" || type === "session.inbox.updated") {
    if (!isRecord(properties) || typeof properties.sessionID !== "string") return
    return `${type}:${directory}:${properties.sessionID}`
  }
  if (type === "lsp.updated") return `lsp.updated:${directory}`
  if (type === "message.part.updated") {
    if (!isRecord(properties) || !isRecord(properties.part)) return
    const part = properties.part
    if (typeof part.messageID !== "string" || typeof part.id !== "string") return
    return `message.part.updated:${directory}:${part.messageID}:${part.id}`
  }
}

function deltaKey(directory: string, messageID: string, partID: string): string {
  return `delta:${directory}:${messageID}:${partID}`
}

export function createEventQueue(options: EventQueueOptions): EventQueue {
  const { emit, isHidden, batch } = options
  const now = options.now ?? Date.now
  const injectedSchedule = options.schedule
  const scheduleTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> | undefined =
    injectedSchedule === undefined
      ? (fn, ms) => setTimeout(fn, ms)
      : (fn, ms) => {
          injectedSchedule(fn, ms)
          return undefined
        }

  let queue: Array<Queued | undefined> = []
  const coalesced = new Map<string, number>()
  // Streaming deltas are unsequenced and self-healing (a full checkpoint
  // follows), so while hidden they can be coalesced per part and flushed later.
  const pendingDelta = new Map<string, PendingDelta>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  let disposed = false

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    const events = queue
    queue = []
    coalesced.clear()
    if (events.length === 0 && pendingDelta.size === 0) return

    last = now()
    batch(() => {
      // Merged deltas are emitted before queued state events regardless of
      // arrival order: deltas are unsequenced and the ≤1 s server checkpoint
      // (`message.part.updated`) is the authoritative snapshot — a checkpoint
      // for the same part clears its pending delta on push (below), so the
      // synthetic delta never double-applies. Emitting them first keeps the
      // streaming renderer fed before state churn, which is harmless because
      // sequenced state events are applied in the same batch.
      for (const entry of pendingDelta.values()) {
        emit(entry.directory, {
          type: "message.part.delta",
          properties: {
            sessionID: entry.sessionID,
            messageID: entry.messageID,
            partID: entry.partID,
            kind: entry.kind,
            delta: entry.delta,
          },
        })
      }
      pendingDelta.clear()
      for (const event of events) {
        if (!event) continue
        emit(event.directory, event.payload)
      }
    })
  }

  const scheduleFlush = () => {
    if (timer !== undefined) return
    const cadence = isHidden() ? HIDDEN_FLUSH_MS : VISIBLE_FLUSH_MS
    const elapsed = now() - last
    timer = scheduleTimer(flush, Math.max(0, cadence - elapsed))
  }

  const push = (directory: string, payload: unknown) => {
    if (disposed) return
    if (queue.length + pendingDelta.size >= EVENT_QUEUE_CAP) flush()

    if (isHidden() && isRecord(payload)) {
      if (payload.type === "message.part.delta") {
        const properties = payload.properties
        if (!isRecord(properties)) return
        const { messageID, partID, kind, delta } = properties
        if (typeof messageID !== "string" || typeof partID !== "string") return
        const key = deltaKey(directory, messageID, partID)
        const existing = pendingDelta.get(key)
        if (existing) {
          existing.delta += typeof delta === "string" ? delta : ""
          if (typeof kind === "string") existing.kind = kind
        } else {
          pendingDelta.set(key, {
            directory,
            sessionID: typeof properties.sessionID === "string" ? properties.sessionID : "",
            messageID,
            partID,
            kind: typeof kind === "string" ? kind : "",
            delta: typeof delta === "string" ? delta : "",
          })
        }
        scheduleFlush()
        return
      }
      if (payload.type === "message.part.updated") {
        const properties = payload.properties
        if (isRecord(properties) && isRecord(properties.part)) {
          const part = properties.part
          if (typeof part.messageID === "string" && typeof part.id === "string") {
            pendingDelta.delete(deltaKey(directory, part.messageID, part.id))
          }
        }
      }
    }

    const k = eventKey(directory, payload)
    if (k) {
      const index = coalesced.get(k)
      if (index !== undefined) {
        queue[index] = undefined
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ directory, payload })
    scheduleFlush()
  }

  const dispose = () => {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    flush()
  }

  return { push, flush, dispose }
}

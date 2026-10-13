export type EventQueueOptions = {
  emit: (scopeID: string, payload: unknown) => void
  isHidden: () => boolean
  batch: <T>(fn: () => T) => T
  schedule?: (fn: () => void, ms: number) => void
  now?: () => number
  onDrain?: (count: number, duration: number, pending: number) => void
}

export type EventQueue = {
  push: (scopeID: string, payload: unknown) => void
  flush: () => void
  dispose: () => void
}

export const EVENT_QUEUE_CAP = 4000
export const VISIBLE_FLUSH_MS = 16
export const HIDDEN_FLUSH_MS = 1000
export const EVENT_BATCH_SIZE = 64
export const EVENT_BATCH_MS = 4

type Queued = { scopeID: string; payload: unknown }

type PendingDelta = {
  index: number
  properties: {
    sessionID: string
    messageID: string
    partID: string
    kind: string
    delta: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function eventKey(scopeID: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) return
  const type = payload.type
  const properties = payload.properties
  if (typeof payload.seq === "number") return
  if (type === "session.status" || type === "session.inbox.updated") {
    if (!isRecord(properties) || typeof properties.sessionID !== "string") return
    return `${type}:${scopeID}:${properties.sessionID}`
  }
  if (type === "lsp.updated") return `lsp.updated:${scopeID}`
  if (type === "message.part.updated") {
    if (!isRecord(properties) || !isRecord(properties.part)) return
    const part = properties.part
    if (typeof part.messageID !== "string" || typeof part.id !== "string") return
    return `message.part.updated:${scopeID}:${part.messageID}:${part.id}`
  }
  if (type === "message.part.summary" && isRecord(properties) && !properties.content && isRecord(properties.summary)) {
    const part = properties.summary
    if (typeof part.messageID === "string" && typeof part.id === "string")
      return `message.part.${properties.discovery ? "discovery" : "summary"}:${scopeID}:${part.messageID}:${part.id}`
  }
}

function deltaKey(scopeID: string, messageID: string, partID: string): string {
  return `delta:${scopeID}:${messageID}:${partID}`
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
  let head = 0
  const coalesced = new Map<string, number>()
  // Streaming deltas are unsequenced and self-healing (a full checkpoint
  // follows), so while hidden they can be coalesced per part and flushed later.
  const pendingDelta = new Map<string, PendingDelta>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let scheduleVersion = 0
  let last = 0
  let disposed = false

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    scheduled = false
    scheduleVersion++
    if (head === queue.length) return

    last = now()
    let count = 0
    batch(() => {
      while (head < queue.length && count < EVENT_BATCH_SIZE && (count === 0 || now() - last < EVENT_BATCH_MS)) {
        const index = head++
        const event = queue[index]
        queue[index] = undefined
        count++
        if (!event) continue
        const key = eventKey(event.scopeID, event.payload)
        if (key && coalesced.get(key) === index) coalesced.delete(key)
        if (
          isRecord(event.payload) &&
          event.payload.type === "message.part.delta" &&
          isRecord(event.payload.properties)
        ) {
          const { messageID, partID } = event.payload.properties
          if (typeof messageID === "string" && typeof partID === "string") {
            const key = deltaKey(event.scopeID, messageID, partID)
            if (pendingDelta.get(key)?.index === index) pendingDelta.delete(key)
          }
        }
        emit(event.scopeID, event.payload)
      }
    })
    options.onDrain?.(count, now() - last, queue.length - head)
    if (head === queue.length) {
      queue = []
      head = 0
      coalesced.clear()
      pendingDelta.clear()
    } else {
      if (head >= EVENT_QUEUE_CAP) {
        queue = queue.slice(head)
        for (const [key, index] of coalesced) coalesced.set(key, index - head)
        for (const pending of pendingDelta.values()) pending.index -= head
        head = 0
      }
      if (!disposed) scheduleFlush(true)
    }
  }

  const scheduleFlush = (continuation = false) => {
    if (scheduled) return
    scheduled = true
    const version = ++scheduleVersion
    const cadence = isHidden() ? HIDDEN_FLUSH_MS : VISIBLE_FLUSH_MS
    const elapsed = now() - last
    timer = scheduleTimer(
      () => {
        if (version === scheduleVersion) flush()
      },
      continuation ? 0 : Math.max(0, cadence - elapsed),
    )
  }

  const push = (scopeID: string, payload: unknown) => {
    if (disposed) return
    if (queue.length - head >= EVENT_QUEUE_CAP) flush()

    if (isRecord(payload)) {
      if (isHidden() && payload.type === "message.part.delta") {
        const properties = payload.properties
        if (!isRecord(properties)) return
        const { messageID, partID, kind, delta } = properties
        if (typeof messageID !== "string" || typeof partID !== "string") return
        const key = deltaKey(scopeID, messageID, partID)
        const existing = pendingDelta.get(key)
        if (existing) {
          existing.properties.delta += typeof delta === "string" ? delta : ""
          if (typeof kind === "string") existing.properties.kind = kind
        } else {
          const merged = {
            sessionID: typeof properties.sessionID === "string" ? properties.sessionID : "",
            messageID,
            partID,
            kind: typeof kind === "string" ? kind : "",
            delta: typeof delta === "string" ? delta : "",
          }
          // Keep the merged delta after the checkpoint that introduced its prefix.
          pendingDelta.set(key, { index: queue.length, properties: merged })
          queue.push({ scopeID, payload: { type: "message.part.delta", properties: merged } })
        }
        scheduleFlush()
        return
      }
      if (payload.type === "message.part.updated") {
        const properties = payload.properties
        if (isRecord(properties) && isRecord(properties.part)) {
          const part = properties.part
          if (typeof part.messageID === "string" && typeof part.id === "string") {
            const key = deltaKey(scopeID, part.messageID, part.id)
            const pending = pendingDelta.get(key)
            if (pending) queue[pending.index] = undefined
            pendingDelta.delete(key)
          }
        }
      }
    }

    const k = eventKey(scopeID, payload)
    if (k) {
      const index = coalesced.get(k)
      if (index !== undefined) {
        queue[index] = undefined
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ scopeID, payload })
    scheduleFlush()
  }

  const dispose = () => {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    while (head < queue.length) flush()
  }

  return { push, flush, dispose }
}

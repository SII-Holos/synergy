import type { ViewEvent } from "./view-projection"

type Schedule = (flush: () => void, delay: number) => () => void
const schedule: Schedule = (flush, delay) => {
  const timer = setTimeout(flush, delay)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createProjectionCursors(send: (event: ViewEvent) => void, later: Schedule = schedule) {
  const pending = new Map<string | null, ViewEvent>()
  let cancel: (() => void) | undefined
  let disposed = false
  function flush(scopeID: string | null) {
    const event = pending.get(scopeID)
    pending.delete(scopeID)
    if (!pending.size) {
      cancel?.()
      cancel = undefined
    }
    if (event && !disposed) send(event)
  }
  function flushAll() {
    for (const scope of pending.keys()) flush(scope)
  }
  return {
    project(event: ViewEvent): ViewEvent | null {
      if (disposed) return null
      const previous = pending.get(event.scopeID)
      if (event.payload.type !== "server.cursor") {
        if (event.payload.seq !== undefined && event.payload.epoch !== undefined) flush(event.scopeID)
        return disposed ? null : event
      }
      if (
        previous &&
        previous.payload.epoch === event.payload.epoch &&
        previous.payload.seq! + 1 === event.payload.properties.fromSeq
      ) {
        pending.set(event.scopeID, {
          ...event,
          payload: {
            ...event.payload,
            properties: { ...event.payload.properties, fromSeq: previous.payload.properties.fromSeq },
          },
        })
      } else {
        flush(event.scopeID)
        if (pending.size >= 128) flush(pending.keys().next().value!)
        if (disposed) return null
        pending.set(event.scopeID, event)
      }
      cancel ??= later(flushAll, 50)
      return null
    },
    flush: flushAll,
    dispose() {
      disposed = true
      cancel?.()
      cancel = undefined
      pending.clear()
    },
  }
}

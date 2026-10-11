import type { SessionPartPage } from "@ericsanchezok/synergy-sdk/client"

const MAX_BATCH_MESSAGE_IDS = 100

/**
 * Refresh-time fan-in for plain first-page Part summary reads: within one
 * microtask all pending reads for a session are merged into batches of up to
 * 100 messages, avoiding per-message requests that stall behind the browser's
 * HTTP/1.1 connection limit during a full reload. Targeted reads (cursor,
 * partID, older) bypass this and hit the per-message endpoint directly.
 */
export function isPlainPartPageQuery(query: { cursor?: string; partID?: string; older?: boolean }): boolean {
  return !query.cursor && !query.partID && !query.older
}

type Entry = {
  isSettled: boolean
  onCancel?: () => void
  resolve: (page: SessionPartPage) => void
  reject: (error: unknown) => void
}

export function createPartPageBatchReader(input: {
  read: (sessionID: string, messageIDs: string[], signal?: AbortSignal) => Promise<Record<string, SessionPartPage>>
}): (sessionID: string, messageID: string, signal: AbortSignal) => Promise<SessionPartPage> {
  const queues = new Map<string, Map<string, Entry[]>>()
  const scheduled = new Set<string>()

  function flush(sessionID: string) {
    scheduled.delete(sessionID)
    const queue = queues.get(sessionID)
    queues.delete(sessionID)
    if (!queue) return
    const live = [...queue.entries()].filter(([, entries]) => entries.some((entry) => !entry.isSettled))
    for (let start = 0; start < live.length; start += MAX_BATCH_MESSAGE_IDS) {
      void readChunk(sessionID, live.slice(start, start + MAX_BATCH_MESSAGE_IDS))
    }
  }

  async function readChunk(sessionID: string, messages: [string, Entry[]][]) {
    const live = messages.filter(([, entries]) => entries.some((entry) => !entry.isSettled))
    if (!live.length) return
    const controller = new AbortController()
    const consumers = new Set(live.flatMap(([, entries]) => entries.filter((entry) => !entry.isSettled)))
    for (const entry of consumers) {
      entry.onCancel = () => {
        consumers.delete(entry)
        if (!consumers.size) controller.abort()
      }
    }
    try {
      const pages = await input.read(
        sessionID,
        live.map(([messageID]) => messageID),
        controller.signal,
      )
      for (const [messageID, entries] of live) {
        const page = pages[messageID]
        for (const entry of entries) {
          if (!page) entry.reject(new Error("Missing conversation summary"))
          else entry.resolve(page)
        }
      }
    } catch (error) {
      for (const [, entries] of live) for (const entry of entries) entry.reject(error)
    }
  }

  const abortError = () => new DOMException("The operation was aborted", "AbortError")

  return (sessionID, messageID, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError())
      let queue = queues.get(sessionID)
      if (!queue) {
        queue = new Map()
        queues.set(sessionID, queue)
      }
      let entries = queue.get(messageID)
      if (!entries) {
        entries = []
        queue.set(messageID, entries)
      }
      const entry: Entry = {
        isSettled: false,
        resolve: (page) => {
          if (settle()) resolve(page)
        },
        reject: (error) => {
          if (settle()) reject(error)
        },
      }
      const settle = () => {
        if (entry.isSettled) return false
        entry.isSettled = true
        signal.removeEventListener("abort", onAbort)
        entry.onCancel = undefined
        return true
      }
      const onAbort = () => {
        const onCancel = entry.onCancel
        entry.reject(abortError())
        onCancel?.()
      }
      signal.addEventListener("abort", onAbort)
      entries.push(entry)
      if (!scheduled.has(sessionID)) {
        scheduled.add(sessionID)
        queueMicrotask(() => void flush(sessionID))
      }
    })
}

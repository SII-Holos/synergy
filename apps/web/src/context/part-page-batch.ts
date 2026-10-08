import type { SessionPartPage } from "@ericsanchezok/synergy-sdk/client"

/**
 * Refresh-time fan-in for plain first-page Part summary reads: within one
 * microtask all pending reads for a session are merged into a single batch
 * request, avoiding per-message requests that stall behind the browser's
 * HTTP/1.1 connection limit during a full reload. Targeted reads (cursor,
 * partID, older) bypass this and hit the per-message endpoint directly.
 */
export function isPlainPartPageQuery(query: { cursor?: string; partID?: string; older?: boolean }): boolean {
  return !query.cursor && !query.partID && !query.older
}

type Entry = {
  signal: AbortSignal
  resolve: (page: SessionPartPage) => void
  reject: (error: unknown) => void
}

export function createPartPageBatchReader(input: {
  read: (sessionID: string, messageIDs: string[], signal?: AbortSignal) => Promise<Record<string, SessionPartPage>>
}): (sessionID: string, messageID: string, signal: AbortSignal) => Promise<SessionPartPage> {
  const queues = new Map<string, Map<string, Entry[]>>()
  const scheduled = new Set<string>()

  async function flush(sessionID: string) {
    scheduled.delete(sessionID)
    const queue = queues.get(sessionID)
    queues.delete(sessionID)
    if (!queue) return
    const live = [...queue.entries()].filter(([, entries]) => entries.some((entry) => !entry.signal.aborted))
    for (const [, entries] of queue)
      for (const entry of entries.filter((item) => item.signal.aborted)) entry.reject(abortError())
    if (!live.length) return
    const signals = live.flatMap(([, entries]) =>
      entries.filter((entry) => !entry.signal.aborted).map((entry) => entry.signal),
    )
    try {
      const pages = await input.read(
        sessionID,
        live.map(([messageID]) => messageID),
        combine(signals),
      )
      for (const [messageID, entries] of live) {
        const page = pages[messageID]
        for (const entry of entries.filter((item) => !item.signal.aborted)) {
          if (!page) entry.reject(new Error("Missing conversation summary"))
          else entry.resolve(page)
        }
      }
    } catch (error) {
      for (const [, entries] of live)
        for (const entry of entries.filter((item) => !item.signal.aborted)) entry.reject(error)
    }
  }

  const abortError = () => new DOMException("The operation was aborted", "AbortError")
  const combine = (signals: AbortSignal[]) =>
    typeof AbortSignal.any === "function" && signals.length ? AbortSignal.any(signals) : undefined

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
      entries.push({ signal, resolve, reject })
      if (!scheduled.has(sessionID)) {
        scheduled.add(sessionID)
        queueMicrotask(() => void flush(sessionID))
      }
    })
}

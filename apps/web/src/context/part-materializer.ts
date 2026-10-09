import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import type { ContentBudget } from "./content-budget"
import { PartSummarySupersededError } from "./part-summary-loader"

type Load = {
  controller: AbortController
  reading?: AbortController
  ready: Promise<void>
}
type Entry = {
  summary: SessionPartSummary
  accepted?: SessionPartSummary
  load?: Load
  consumers: number
  bytes: number
  attempts: number
  failure?: unknown
  ready: Promise<void>
  unsubscribe?: () => void
}

export class PartContentSyncError extends Error {
  constructor() {
    super("Conversation content kept changing while loading")
    this.name = "PartContentSyncError"
  }
}

const isConflict = (error: unknown) =>
  !!error && typeof error === "object" && "name" in error && error.name === "SessionDisplayConflict"
const snapshot = (summary: SessionPartSummary): SessionPartSummary => ({ ...summary, content: { ...summary.content } })

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })

export function createPartMaterializer(input: {
  budget?: number
  read: (summary: SessionPartSummary, signal: AbortSignal) => Promise<{ part: Part; version: string }>
  refresh?: (summary: SessionPartSummary, signal: AbortSignal) => Promise<SessionPartSummary | undefined>
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  apply: (part: Part, summary: SessionPartSummary) => void
  isCurrent?: (summary: SessionPartSummary) => boolean
  evict: (summary: SessionPartSummary) => void
  subscribe?: (summary: SessionPartSummary) => () => void
  memory?: ContentBudget
  memoryKey?: (summary: SessionPartSummary) => string
}) {
  const entries = new Map<string, Entry>()
  const budget = input.budget ?? 128 * 1024 * 1024
  let bytes = 0
  let disposed = false
  const keyOf = (item: SessionPartSummary) => `${item.messageID}\0${item.id}`
  const memoryKey = (summary: SessionPartSummary) => input.memoryKey?.(summary) ?? keyOf(summary)
  const wait = input.wait ?? pause
  const remove = (key: string, entry: Entry, memoryEvicted = false) => {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    bytes -= entry.bytes
    entry.load?.controller.abort()
    entry.unsubscribe?.()
    entry.unsubscribe = undefined
    if (entry.accepted) {
      if (!memoryEvicted) input.memory?.remove(memoryKey(entry.accepted), entry.accepted.content.version)
      input.evict(entry.accepted)
    }
  }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= budget) break
      if (!entry.consumers) remove(key, entry)
    }
  }
  const start = (key: string, entry: Entry) => {
    const load: Load = { controller: new AbortController(), ready: Promise.resolve() }
    entry.load = load
    const current = () =>
      !disposed && !load.controller.signal.aborted && entries.get(key) === entry && entry.load === load
    load.ready = (async () => {
      while (current()) {
        const limit = entry.accepted ? 4 : 8
        if (entry.attempts >= limit) throw new PartContentSyncError()
        const summary = entry.summary
        const reading = new AbortController()
        load.reading = reading
        const abort = () => reading.abort()
        load.controller.signal.addEventListener("abort", abort, { once: true })
        entry.attempts++
        let refresh = false
        try {
          const result = await abortable(input.read(summary, reading.signal), reading.signal)
          if (!current()) return
          if (
            result.version === summary.content.version &&
            entry.summary.content.version === summary.content.version &&
            input.isCurrent?.(summary) !== false
          ) {
            input.apply(result.part, summary)
            bytes += summary.content.bytes * 2 - entry.bytes
            entry.bytes = summary.content.bytes * 2
            entry.accepted = summary
            entry.attempts = 0
            entry.failure = undefined
            input.memory?.publish(memoryKey(summary), summary.content.version, entry.bytes, () =>
              remove(key, entry, true),
            )
            trim()
            return
          }
          refresh = entry.summary.content.version === summary.content.version
          if (refresh && !input.refresh) {
            remove(key, entry)
            return
          }
        } catch (error) {
          if (!current()) return
          if (reading.signal.aborted && entry.summary.content.version !== summary.content.version) refresh = false
          else if (isConflict(error) && input.refresh) refresh = true
          else throw error
        } finally {
          load.controller.signal.removeEventListener("abort", abort)
          if (load.reading === reading) load.reading = undefined
        }
        if (entry.attempts >= limit) throw new PartContentSyncError()
        if (refresh) {
          try {
            const updated = await abortable(input.refresh!(summary, load.controller.signal), load.controller.signal)
            if (!current()) return
            if (!updated) {
              remove(key, entry)
              return
            }
            if (input.isCurrent?.(updated) !== false) entry.summary = snapshot(updated)
          } catch (error) {
            if (!current()) return
            if (!(error instanceof PartSummarySupersededError) && !isConflict(error)) throw error
          }
        }
        const failures = (entry.attempts - 1) % 4
        await abortable(wait(100 * 2 ** failures, load.controller.signal), load.controller.signal)
      }
    })()
      .catch((error) => {
        if (!current()) return
        entry.failure = error
        throw error
      })
      .finally(() => {
        if (entry.load === load) entry.load = undefined
      })
    entry.ready = load.ready
  }
  return {
    get bytes() {
      return bytes
    },
    retain(summary: SessionPartSummary) {
      if (disposed) throw new Error("The conversation content cache is disposed")
      const key = keyOf(summary)
      let entry = entries.get(key)
      if (!entry) {
        entry = { summary: snapshot(summary), consumers: 0, bytes: 0, attempts: 0, ready: Promise.resolve() }
        entries.set(key, entry)
      }
      const changed = entry.summary.content.version !== summary.content.version
      if (changed) {
        entry.summary = snapshot(summary)
        entry.load?.reading?.abort()
      }
      if (
        !entry.load &&
        !(entry.failure instanceof PartContentSyncError) &&
        entry.accepted?.content.version !== summary.content.version &&
        (!entry.failure || changed)
      )
        start(key, entry)
      entries.delete(key)
      entries.set(key, entry)
      const retained = entry
      const ready = retained.ready
      if (!retained.consumers) retained.unsubscribe = input.subscribe?.(summary)
      retained.consumers++
      const releaseMemory = input.memory?.retain(memoryKey(summary))
      let released = false
      return {
        ready,
        isCurrent: () => !released && !disposed && entries.get(key) === retained && retained.ready === ready,
        release() {
          if (released) return
          released = true
          releaseMemory?.()
          retained.consumers--
          if (!retained.consumers) {
            retained.unsubscribe?.()
            retained.unsubscribe = undefined
            retained.load?.controller.abort()
            retained.load = undefined
            retained.failure = undefined
            retained.attempts = 0
            retained.ready = Promise.resolve()
            if (!retained.accepted) remove(key, retained)
          }
          trim()
        },
      }
    },
    invalidate(messageID: string, partID?: string) {
      for (const [key, entry] of entries) {
        if (entry.summary.messageID === messageID && (!partID || entry.summary.id === partID)) remove(key, entry)
      }
    },
    revalidate(messageID: string) {
      for (const entry of entries.values()) {
        if (entry.summary.messageID !== messageID) continue
        entry.load?.controller.abort()
        entry.load = undefined
        entry.failure = undefined
        entry.attempts = 0
        entry.ready = Promise.resolve()
      }
    },
    dispose() {
      disposed = true
      for (const [key, entry] of entries) remove(key, entry)
    },
  }
}

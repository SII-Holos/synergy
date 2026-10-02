import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import type { ContentBudget } from "./content-budget"

type Entry = {
  summary: SessionPartSummary
  controller: AbortController
  consumers: number
  bytes: number
  ready: Promise<void>
}

export function createPartMaterializer(input: {
  budget?: number
  read: (summary: SessionPartSummary, signal: AbortSignal) => Promise<{ part: Part; version: string }>
  apply: (part: Part, summary: SessionPartSummary) => void
  isCurrent?: (summary: SessionPartSummary) => boolean
  evict: (summary: SessionPartSummary) => void
  subscribe?: (summary: SessionPartSummary) => () => void
  memory?: ContentBudget
  memoryKey?: (summary: SessionPartSummary) => string
}) {
  const entries = new Map<string, Entry>()
  const subscriptions = new Map<string, { consumers: number; release?: () => void }>()
  const budget = input.budget ?? 128 * 1024 * 1024
  let bytes = 0
  let disposed = false
  const keyOf = (item: SessionPartSummary) => `${item.messageID}\0${item.id}`
  const memoryKey = (summary: SessionPartSummary) => input.memoryKey?.(summary) ?? keyOf(summary)
  const remove = (key: string, entry: Entry, memoryEvicted = false) => {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    bytes -= entry.bytes
    entry.controller.abort()
    if (!memoryEvicted) input.memory?.remove(memoryKey(entry.summary), entry.summary.content.version)
    if (entry.bytes) input.evict(entry.summary)
  }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= budget) break
      if (!entry.consumers) remove(key, entry)
    }
  }
  return {
    get bytes() {
      return bytes
    },
    retain(summary: SessionPartSummary) {
      if (disposed) throw new Error("The conversation content cache is disposed")
      const key = keyOf(summary)
      let entry = entries.get(key)
      if (entry && entry.summary.content.version !== summary.content.version) {
        remove(key, entry)
        entry = undefined
      }
      if (!entry) {
        const created: Entry = {
          summary,
          controller: new AbortController(),
          consumers: 0,
          bytes: 0,
          ready: Promise.resolve(),
        }
        entries.set(key, created)
        let reading: ReturnType<typeof input.read>
        try {
          reading = input.read(summary, created.controller.signal)
        } catch (error) {
          reading = Promise.reject(error)
        }
        created.ready = reading
          .then((result) => {
            if (disposed || created.controller.signal.aborted || entries.get(key) !== created) return
            if (result.version !== summary.content.version) throw new Error("Conversation content version changed")
            if (input.isCurrent?.(summary) === false) {
              remove(key, created)
              return
            }
            input.apply(result.part, summary)
            created.bytes = summary.content.bytes * 2
            bytes += created.bytes
            input.memory?.publish(memoryKey(summary), summary.content.version, created.bytes, () =>
              remove(key, created, true),
            )
            trim()
          })
          .catch((error) => {
            const aborted = created.controller.signal.aborted
            if (entries.get(key) === created) remove(key, created)
            if (!aborted) throw error
          })
        entry = created
      }
      entries.delete(key)
      entries.set(key, entry)
      const retained = entry
      let subscription = subscriptions.get(key)
      if (!subscription) {
        subscription = { consumers: 0, release: input.subscribe?.(summary) }
        subscriptions.set(key, subscription)
      }
      const retainedSubscription = subscription
      retainedSubscription.consumers++
      retained.consumers++
      const releaseMemory = input.memory?.retain(memoryKey(summary))
      let released = false
      return {
        ready: retained.ready,
        release() {
          if (released) return
          released = true
          releaseMemory?.()
          retained.consumers--
          retainedSubscription.consumers--
          if (!retainedSubscription.consumers) {
            retainedSubscription.release?.()
            subscriptions.delete(key)
          }
          if (!retained.consumers && !retained.bytes) remove(key, retained)
          trim()
        },
      }
    },
    invalidate(messageID: string, partID?: string) {
      for (const [key, entry] of entries) {
        if (entry.summary.messageID === messageID && (!partID || entry.summary.id === partID)) remove(key, entry)
      }
    },
    dispose() {
      disposed = true
      for (const [key, entry] of entries) remove(key, entry)
      for (const subscription of subscriptions.values()) subscription.release?.()
      subscriptions.clear()
    },
  }
}

import type { ContentSummaryProperties } from "./content-subscriptions"
import type { Part } from "@ericsanchezok/synergy-sdk"

export function createPartProjectionStream(input: {
  accepts(scopeID: string, properties: ContentSummaryProperties): boolean
  read(
    scopeID: string,
    properties: ContentSummaryProperties,
    signal: AbortSignal,
  ): Promise<{ part: Part; version: string }>
  emit(scopeID: string, properties: ContentSummaryProperties): void
  discard(scopeID: string, properties: ContentSummaryProperties): void
  recover(scopeID: string, properties: ContentSummaryProperties): void
}) {
  type State = {
    controller: AbortController
    properties: ContentSummaryProperties
    pending: Promise<void>
    queued: number
  }
  const entries = new Map<string, State>()
  let disposed = false
  return {
    receive(scopeID: string, properties: ContentSummaryProperties, reset = false) {
      if (disposed) return Promise.resolve()
      if (!input.accepts(scopeID, properties)) {
        input.discard(scopeID, properties)
        return Promise.resolve()
      }
      const key = JSON.stringify([scopeID, properties.summary.messageID, properties.summary.id])
      let state = entries.get(key)
      if (state && (reset || state.properties.subscription !== properties.subscription)) {
        state.controller.abort()
        entries.delete(key)
        state = undefined
      }
      if (!state && properties.content?.kind !== "reference") {
        input.emit(scopeID, properties)
        return Promise.resolve()
      }
      if (!state) {
        state = { controller: new AbortController(), properties, pending: Promise.resolve(), queued: 0 }
        entries.set(key, state)
      }
      const current = state
      const valid = () =>
        !disposed &&
        !current.controller.signal.aborted &&
        entries.get(key) === current &&
        input.accepts(scopeID, properties)
      const recover = () => {
        if (!valid()) return
        current.controller.abort()
        entries.delete(key)
        input.recover(scopeID, properties)
        input.discard(scopeID, current.properties)
      }
      if (++current.queued > 64) {
        recover()
        return Promise.resolve()
      }
      current.pending = current.pending
        .then(async () => {
          if (!valid()) return
          if (properties.content?.kind === "reference") {
            const result = await input.read(scopeID, properties, current.controller.signal)
            if (!valid()) return
            if (result.version !== properties.summary.content.version) {
              recover()
              return
            }
            input.emit(scopeID, { ...properties, content: { kind: "checkpoint", part: result.part } })
          } else input.emit(scopeID, properties)
        })
        .catch(recover)
        .finally(() => {
          if (--current.queued === 0 && entries.get(key) === current) entries.delete(key)
        })
      return current.pending
    },
    prune() {
      for (const [key, state] of entries) {
        const [scopeID] = JSON.parse(key) as string[]
        if (input.accepts(scopeID, state.properties)) continue
        state.controller.abort()
        entries.delete(key)
        input.discard(scopeID, state.properties)
      }
    },
    dispose() {
      disposed = true
      for (const state of entries.values()) state.controller.abort()
      entries.clear()
    },
  }
}

import type { WorkspaceFileStatusSummary } from "@ericsanchezok/synergy-sdk"

type Consumer = {
  active: number
  load(signal: AbortSignal): Promise<WorkspaceFileStatusSummary | undefined>
  publish(value: WorkspaceFileStatusSummary): void
}
type Entry = {
  consumers: Set<Consumer>
  revision: number
  dirty: boolean
  started: number
  expires: number
  value?: WorkspaceFileStatusSummary
  pending?: Promise<void>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
}

export function createFileStatusRegistry(coalesced: () => void = () => {}) {
  const entries = new Map<string, Entry>()
  const active = (entry: Entry) => [...entry.consumers].some((consumer) => consumer.active > 0)
  const clearTimer = (entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
  }
  function schedule(key: string, entry: Entry) {
    if (!entry.dirty || entry.pending || entry.timer || !active(entry)) return
    const delay = Math.max(0, 500 - (performance.now() - entry.started))
    if (!delay) {
      void start(key, entry)
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      schedule(key, entry)
    }, delay)
  }
  function start(key: string, entry: Entry, explicit?: Consumer): Promise<void> {
    if (entry.pending) return entry.pending
    const consumer = explicit ?? [...entry.consumers].find((value) => value.active > 0)
    if (!consumer) return Promise.resolve()
    clearTimer(entry)
    entry.dirty = false
    entry.started = performance.now()
    const revision = entry.revision
    const controller = new AbortController()
    entry.controller = controller
    let loading: Promise<WorkspaceFileStatusSummary | undefined>
    try {
      loading = consumer.load(controller.signal)
    } catch (error) {
      loading = Promise.reject(error)
    }
    const pending = loading
      .then((value) => {
        if (controller.signal.aborted || revision !== entry.revision || !value) return
        entry.value = value
        entry.expires = performance.now() + 5_000
        for (const consumer of entry.consumers) consumer.publish(value)
      })
      .catch(() => {
        entry.dirty = true
      })
      .finally(() => {
        entry.pending = undefined
        entry.controller = undefined
        if (!entry.consumers.size) entries.delete(key)
        else if (revision !== entry.revision) schedule(key, entry)
      })
    entry.pending = pending
    return pending
  }
  return {
    retain(key: string, load: Consumer["load"], publish: Consumer["publish"]) {
      let entry = entries.get(key)
      if (!entry) {
        entry = { consumers: new Set(), revision: 0, dirty: false, started: -Infinity, expires: 0 }
        entries.set(key, entry)
      }
      const value = entry
      const consumer: Consumer = { active: 0, load, publish }
      value.consumers.add(consumer)
      if (value.value) publish(value.value)
      if (value.controller?.signal.aborted) {
        value.revision++
        value.dirty = true
      }
      return {
        read() {
          if (!value.consumers.has(consumer)) return Promise.resolve()
          if (value.pending) return value.pending
          if (!value.dirty && value.value && value.expires > performance.now()) {
            publish(value.value)
            return Promise.resolve()
          }
          if (performance.now() - value.started < 500) {
            value.dirty = true
            schedule(key, value)
            return Promise.resolve()
          }
          return start(key, value, consumer)
        },
        invalidate() {
          if (!value.consumers.has(consumer)) return
          if (value.dirty || value.pending) coalesced()
          value.revision++
          value.dirty = true
          schedule(key, value)
        },
        activate() {
          if (!value.consumers.has(consumer)) return () => {}
          consumer.active++
          schedule(key, value)
          let released = false
          return () => {
            if (released) return
            released = true
            consumer.active--
            if (!active(value)) clearTimer(value)
          }
        },
        dispose() {
          value.consumers.delete(consumer)
          if (!active(value)) clearTimer(value)
          if (value.consumers.size) return
          value.controller?.abort()
          if (!value.pending) entries.delete(key)
        },
      }
    },
  }
}

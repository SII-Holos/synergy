import { createSignal } from "solid-js"

type Arrival = { source: "live" | "replay" | "discovery"; render: boolean; previous: boolean | undefined }

export function createPartArrivalState(now = () => performance.now()) {
  const pending = new Map<string, number>()
  const consumed = new Set<string>()
  let foreground: { owner: string; ready: boolean; advance(): void } | undefined
  const prune = () => {
    for (const [id, expires] of pending) if (expires <= now()) pending.delete(id)
  }
  return {
    open(owner: readonly string[]) {
      const [revision, setRevision] = createSignal(0)
      const view = { owner: JSON.stringify(owner), ready: false, advance: () => setRevision((value) => value + 1) }
      foreground = view
      pending.clear()
      consumed.clear()
      return {
        revision,
        ready(value: boolean) {
          if (foreground !== view) return
          view.ready = value
          if (!value) pending.clear()
        },
        take(partID: string) {
          if (foreground !== view || !view.ready) return false
          const expires = pending.get(partID)
          pending.delete(partID)
          if (expires === undefined || expires <= now()) return false
          consumed.add(partID)
          while (consumed.size > 512) consumed.delete(consumed.values().next().value!)
          return true
        },
        release() {
          if (foreground !== view) return
          foreground = undefined
          pending.clear()
          consumed.clear()
        },
      }
    },
    add(owner: readonly string[], partID: string, input: Arrival) {
      if (!foreground?.ready || foreground.owner !== JSON.stringify(owner) || input.source !== "live" || !input.render)
        return
      foreground.advance()
      if (input.previous === true || consumed.has(partID)) return
      prune()
      pending.set(partID, now() + 2000)
      while (pending.size > 64) pending.delete(pending.keys().next().value!)
    },
    clear() {
      foreground = undefined
      pending.clear()
      consumed.clear()
    },
  }
}

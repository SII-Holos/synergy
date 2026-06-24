/**
 * Session-scoped seen-lines store adapter.
 * Wraps SeenStore with ScopedState + Bus SessionEvent.Deleted cleanup.
 */
import { Bus } from "../bus"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { SessionEvent } from "../session/event"

export interface SeenRange {
  startLine: number
  endLine: number
}

export class SeenStore {
  readonly #ranges = new Map<string, SeenRange[]>()

  recordSeen(path: string, startLine: number, endLine: number): void {
    const existing = this.#ranges.get(path) ?? []
    existing.push({ startLine, endLine })
    this.#ranges.set(path, this.#mergeRanges(existing))
  }

  getSeenRanges(path: string): SeenRange[] {
    return this.#ranges.get(path) ?? []
  }

  isRangeSeen(path: string, startLine: number, endLine: number): boolean {
    const ranges = this.#ranges.get(path)
    if (!ranges || ranges.length === 0) return false
    return ranges.some((r) => r.startLine <= startLine && r.endLine >= endLine)
  }

  clear(): void {
    this.#ranges.clear()
  }

  #mergeRanges(ranges: SeenRange[]): SeenRange[] {
    if (ranges.length <= 1) return ranges
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine)
    const merged: SeenRange[] = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1]
      const curr = sorted[i]
      if (curr.startLine <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, curr.endLine)
      } else {
        merged.push({ ...curr })
      }
    }
    return merged
  }
}

export namespace SessionSeenStore {
  const state = ScopedState.create(() => new Map<string, SeenStore>())

  let cleanupSubscribed = false

  function ensureCleanupSubscription(): void {
    if (cleanupSubscribed) return
    cleanupSubscribed = true
    Bus.subscribe(SessionEvent.Deleted, (event) => {
      clear(event.properties.info.id)
    })
  }

  export function get(sessionID: string): SeenStore {
    ensureCleanupSubscription()
    const stores = state()
    let store = stores.get(sessionID)
    if (!store) {
      store = new SeenStore()
      stores.set(sessionID, store)
    }
    return store
  }

  export function clear(sessionID?: string): void {
    const stores = state()
    if (sessionID) stores.delete(sessionID)
    else stores.clear()
  }
}

export function groupLineRanges(lines: number[]): SeenRange[] {
  if (lines.length === 0) return []
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const ranges: SeenRange[] = [{ startLine: sorted[0], endLine: sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = ranges[ranges.length - 1]
    if (sorted[i] === last.endLine + 1) last.endLine = sorted[i]
    else ranges.push({ startLine: sorted[i], endLine: sorted[i] })
  }
  return ranges
}

export function recordSeenRanges(store: SeenStore, filePath: string, lines: number[]): void {
  for (const range of groupLineRanges(lines)) {
    store.recordSeen(filePath, range.startLine, range.endLine)
  }
}

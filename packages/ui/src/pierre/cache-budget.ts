import { LRUMap } from "lru_map"

export function highlightInputAllowed(text: string) {
  if (text.length > 32 * 1024) return false
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > 2000) return false
  return true
}

function resultWeight(value: unknown, limit: number): number {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length && bytes <= limit) {
    const next = pending.pop()
    if (typeof next === "string") bytes += next.length * 2
    else if (next && typeof next === "object") {
      if (seen.has(next)) continue
      seen.add(next)
      bytes += 64
      for (const value of Object.values(next)) {
        bytes += 16
        pending.push(value)
      }
    } else bytes += 8
  }
  return bytes
}

type Entry = { bytes: number; evict: () => void }

// Pierre 1.3.3 caches expanded HAST, not source bytes. The local cache-factory
// patch preserves its LRU API while budgeting results across both worker pools.
export function createHighlightCacheBudget(options: { maxBytes?: number; maxEntryBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  const maxEntryBytes = Math.min(options.maxEntryBytes ?? 4 * 1024 * 1024, maxBytes)
  const retained = new Set<Entry>()
  let bytes = 0

  class Cache<T> extends LRUMap<string, T> {
    private readonly weights = new Map<string, Entry>()
    constructor() {
      super(100)
    }
    override get(key: string): T | undefined {
      const value = super.get(key)
      const entry = this.weights.get(key)
      if (entry) {
        retained.delete(entry)
        retained.add(entry)
      }
      return value
    }
    override set(key: string, value: T): this {
      this.delete(key)
      const weight = resultWeight(value, maxEntryBytes)
      if (weight > maxEntryBytes) return this
      while (bytes + weight > maxBytes) retained.values().next().value?.evict()
      super.set(key, value)
      const entry = { bytes: weight, evict: () => this.delete(key) }
      this.weights.set(key, entry)
      retained.add(entry)
      bytes += weight
      return this
    }
    override delete(key: string): T | undefined {
      const entry = this.weights.get(key)
      if (entry) {
        bytes -= entry.bytes
        retained.delete(entry)
        this.weights.delete(key)
      }
      return super.delete(key)
    }
    override shift(): [string, T] | undefined {
      const key = this.keys().next().value
      if (key === undefined) return undefined
      const value = this.delete(key)
      return [key, value!]
    }
    override clear() {
      for (const key of this.weights.keys()) this.delete(key)
    }
  }
  return {
    createCache: <T>() => new Cache<T>(),
    stats: () => ({ bytes, entries: retained.size }),
  }
}

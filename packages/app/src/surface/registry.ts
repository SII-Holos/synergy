import { compareSurfaceEntries, type SurfaceEntry } from "./types"

/**
 * Generic surface registry.
 *
 * Manages entries of type E keyed by `id`. Supports:
 * - register → returns a disposer (idempotent — safe to double-dispose)
 * - list → stable sorted list (order → label → id), optional filter
 * - get / has → O(1) lookup
 * - clear → optionally scoped to one pluginId
 * - subscribe → notified on every mutation
 *
 * Concrete registries re-export the methods under their domain-specific names
 * (e.g., `registerNavigation`, `listNavigation`).
 */
export class SurfaceRegistry<E extends SurfaceEntry> {
  private entries = new Map<string, E>()
  private listeners = new Set<() => void>()

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  register(entry: E): () => void {
    this.entries.set(entry.id, entry)
    this.notify()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.entries.get(entry.id) !== entry) return
      this.entries.delete(entry.id)
      this.notify()
    }
  }

  list(filter?: (entry: E) => boolean): E[] {
    const arr = Array.from(this.entries.values())
    const filtered = filter ? arr.filter(filter) : arr
    return filtered.toSorted(compareSurfaceEntries) as E[]
  }

  get(id: string): E | undefined {
    return this.entries.get(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  clear(pluginId?: string): void {
    if (!pluginId) {
      if (this.entries.size === 0) return
      this.entries.clear()
      this.notify()
      return
    }

    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.pluginId !== pluginId) continue
      this.entries.delete(id)
      changed = true
    }
    if (changed) this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

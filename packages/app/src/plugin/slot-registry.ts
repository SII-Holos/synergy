/**
 * Generic plugin slot registry.
 *
 * Groups plugin surface entries by host-declared slot name. Each slot is a
 * stable sorted list (order → label → id) of entries that contribute a
 * trusted Solid component to a host render position.
 *
 * Registration returns an idempotent disposer. Clearing scopes to one
 * pluginId so a reload/disable/uninstall removes only the owning plugin's
 * entries. Consumers subscribe and re-read the slot list on change.
 *
 * Domains may instantiate their own typed registry (`new SlotRegistry<E>()`);
 * the shared `pluginSlots` instance backs the generic `ui.slot` contributions
 * and the host `SlotOutlet` renderer.
 */
/** Base surface metadata shared by domain entry types (built-in and plugin). */
export interface SurfaceEntry {
  /** Unique surface identifier — scoped per plugin via `pluginId:surfaceId` for plugins. */
  id: string
  /** Human-readable label. */
  label: string
  /** Optional icon name. */
  icon?: string
  /** Sort order — lower values appear first. Default 1000. */
  order?: number
  /** Owning plugin id. Undefined for built-in surfaces. */
  pluginId?: string
}

export interface SlotEntryBase {
  /** Unique entry identifier — scoped per plugin via `pluginId:surfaceId`. */
  id: string
  /** Human-readable label. Optional for headless contributions. */
  label?: string
  /** Optional icon name. */
  icon?: string
  /** Sort order — lower values appear first. Default 1000. */
  order?: number
  /** Owning plugin id. Undefined for built-in surfaces. */
  pluginId?: string
  /** The slot this entry contributes to, e.g. "sidebar.footer". */
  slot: string
  /** Minimal visibility conditions evaluated by the outlet. */
  when?: { session?: boolean }
  /** Lazy loader returning the trusted Solid component. Optional when a
   *  domain passes a component directly through its own entry type. */
  loader?: () => Promise<{ default: unknown }>
}

/** Concrete slot entry used by the shared generic-slot instance. */
export interface SlotEntry extends SlotEntryBase {}

/** Stable ascending sort — order, then label (falling back to id), then id. */
export function compareSlotEntries(a: SlotEntryBase, b: SlotEntryBase): number {
  return (
    (a.order ?? 1000) - (b.order ?? 1000) ||
    (a.label ?? a.id).localeCompare(b.label ?? b.id) ||
    a.id.localeCompare(b.id)
  )
}

interface SlotRecord<E extends SlotEntryBase> {
  entries: Map<string, E>
}

export class SlotRegistry<E extends SlotEntryBase = SlotEntryBase> {
  private records = new Map<string, SlotRecord<E>>()
  private listeners = new Set<() => void>()

  private record(slot: string): SlotRecord<E> {
    let value = this.records.get(slot)
    if (!value) {
      value = { entries: new Map() }
      this.records.set(slot, value)
    }
    return value
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Register one slot entry. Returns an idempotent disposer. */
  register(entry: E): () => void {
    const rec = this.record(entry.slot)
    if (rec.entries.has(entry.id)) throw new Error(`Duplicate slot entry ${entry.id} in slot ${entry.slot}`)
    rec.entries.set(entry.id, entry)
    this.notify()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (rec.entries.get(entry.id) !== entry) return
      rec.entries.delete(entry.id)
      this.notify()
    }
  }

  /** Stable sorted list of entries for one slot. */
  list(slot: string): E[] {
    const rec = this.records.get(slot)
    if (!rec) return []
    return Array.from(rec.entries.values()).toSorted(compareSlotEntries)
  }

  /** All entries across every slot, stably sorted by slot then entry order. */
  listAll(filter?: (entry: E) => boolean): E[] {
    const entries: E[] = []
    for (const rec of this.records.values()) {
      for (const entry of rec.entries.values()) {
        if (!filter || filter(entry)) entries.push(entry)
      }
    }
    return entries.toSorted(compareSlotEntries)
  }

  /** Look up one entry by id across every slot. */
  get(id: string): E | undefined {
    for (const rec of this.records.values()) {
      const entry = rec.entries.get(id)
      if (entry) return entry
    }
    return undefined
  }
  /** Whether an entry with this id exists across every slot. */
  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** Remove entries for one plugin (or all when omitted). */
  clear(pluginId?: string): void {
    let changed = false
    for (const rec of this.records.values()) {
      if (!pluginId) {
        if (rec.entries.size > 0) changed = true
        rec.entries.clear()
        continue
      }
      for (const [id, entry] of rec.entries) {
        if (entry.pluginId !== pluginId) continue
        rec.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  /** Subscribe to slot registry mutations. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Shared registry backing generic `ui.slot` contributions and `SlotOutlet`. */
export const pluginSlots = new SlotRegistry<SlotEntry>()

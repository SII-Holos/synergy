/**
 * Shared surface metadata that all concrete registry entry types extend.
 */
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

/**
 * Stable ascending sort — order, then label, then id.
 */
export function compareSurfaceEntries(a: SurfaceEntry, b: SurfaceEntry): number {
  return (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

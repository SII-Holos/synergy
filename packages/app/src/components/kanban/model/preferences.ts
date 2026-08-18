/**
 * Kanban persisted preferences — pure module (no component imports) so the
 * migration and grid layout config stay unit-testable.
 */

export type KanbanLayout = "grid" | "focus"

export type KanbanPersisted = {
  layout: KanbanLayout
  follow: Record<string, boolean>
  pinned: string[]
  /** Grid layout: fixed number of columns (1–4). */
  gridCols: number
  /** Grid layout: fixed number of visible rows (1–4); extra panes overflow. */
  gridRows: number
}

export const GRID_COL_MIN = 1
export const GRID_COL_MAX = 4
export const GRID_ROW_MIN = 1
export const GRID_ROW_MAX = 4

export function defaultKanbanPreferences(): KanbanPersisted {
  return { layout: "grid", follow: {}, pinned: [], gridCols: 3, gridRows: 2 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function migrateKanbanPreferences(value: unknown): KanbanPersisted {
  const base = defaultKanbanPreferences()
  if (!isRecord(value)) return base
  return {
    layout: value.layout === "focus" ? "focus" : "grid",
    follow: isRecord(value.follow) ? (value.follow as Record<string, boolean>) : {},
    pinned: Array.isArray(value.pinned) ? value.pinned.filter((x): x is string => typeof x === "string") : [],
    gridCols: clampInt(value.gridCols, GRID_COL_MIN, GRID_COL_MAX, base.gridCols),
    gridRows: clampInt(value.gridRows, GRID_ROW_MIN, GRID_ROW_MAX, base.gridRows),
  }
}

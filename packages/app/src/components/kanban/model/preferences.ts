/**
 * Kanban persisted preferences — pure module (no component imports) so the
 * migration and grid layout config stay unit-testable.
 */

export type KanbanLayout = "grid" | "focus"

export type PaneSpan = { cols: 1 | 2; rows: 1 | 2 }

export type KanbanPersisted = {
  layout: KanbanLayout
  follow: Record<string, boolean>
  pinned: string[]
  /** Grid layout: fixed number of columns (1–4). */
  gridCols: number
  /** Grid layout: fixed number of visible rows (1–4); extra panes overflow. */
  gridRows: number
  /** Free layout: panes may span multiple cells via `paneSpans`. */
  freeLayout: boolean
  paneSpans: Record<string, PaneSpan>
}

export const GRID_COL_MIN = 1
export const GRID_COL_MAX = 4
export const GRID_ROW_MIN = 1
export const GRID_ROW_MAX = 4

export function defaultKanbanPreferences(): KanbanPersisted {
  return { layout: "grid", follow: {}, pinned: [], gridCols: 3, gridRows: 2, freeLayout: false, paneSpans: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sanitizePaneSpan(value: unknown): PaneSpan | undefined {
  if (!isRecord(value)) return undefined
  return { cols: value.cols === 2 ? 2 : 1, rows: value.rows === 2 ? 2 : 1 }
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
    freeLayout: value.freeLayout === true,
    paneSpans: isRecord(value.paneSpans)
      ? Object.fromEntries(
          Object.entries(value.paneSpans).flatMap(([key, span]) => {
            const sanitized = sanitizePaneSpan(span)
            return sanitized ? [[key, sanitized]] : []
          }),
        )
      : {},
  }
}

export function spanFor(paneSpans: Record<string, PaneSpan>, key: string): PaneSpan {
  return paneSpans[key] ?? { cols: 1, rows: 1 }
}

export function parsePaneSpan(label: string): PaneSpan {
  if (label === "2x1") return { cols: 2, rows: 1 }
  if (label === "1x2") return { cols: 1, rows: 2 }
  if (label === "2x2") return { cols: 2, rows: 2 }
  return { cols: 1, rows: 1 }
}

export function paneSpanLabel(span: PaneSpan): string {
  return `${span.cols}x${span.rows}`
}

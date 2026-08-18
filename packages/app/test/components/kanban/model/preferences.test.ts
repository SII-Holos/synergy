import { describe, expect, test } from "bun:test"
import {
  defaultKanbanPreferences,
  migrateKanbanPreferences,
  parsePaneSpan,
  paneSpanLabel,
  spanFor,
} from "../../../../src/components/kanban/model/preferences"

describe("migrateKanbanPreferences", () => {
  test("returns defaults for missing or malformed input", () => {
    expect(migrateKanbanPreferences(undefined)).toEqual(defaultKanbanPreferences())
    expect(migrateKanbanPreferences(null)).toEqual(defaultKanbanPreferences())
    expect(migrateKanbanPreferences("garbage")).toEqual(defaultKanbanPreferences())
  })

  test("clamps grid dimensions into the 1-4 range", () => {
    expect(migrateKanbanPreferences({ gridCols: 99, gridRows: -3 }).gridCols).toBe(4)
    expect(migrateKanbanPreferences({ gridCols: 99, gridRows: -3 }).gridRows).toBe(1)
    expect(migrateKanbanPreferences({ gridCols: 2.6, gridRows: 1.4 }).gridCols).toBe(3)
    expect(migrateKanbanPreferences({ gridCols: "3", gridRows: "2" }).gridCols).toBe(3)
  })

  test("keeps only the two known layout values and boolean freeLayout", () => {
    expect(migrateKanbanPreferences({ layout: "focus" }).layout).toBe("focus")
    expect(migrateKanbanPreferences({ layout: "waterfall" }).layout).toBe("grid")
    expect(migrateKanbanPreferences({ freeLayout: true }).freeLayout).toBe(true)
    expect(migrateKanbanPreferences({ freeLayout: "yes" }).freeLayout).toBe(false)
  })

  test("sanitizes pane spans and drops invalid entries", () => {
    const migrated = migrateKanbanPreferences({
      paneSpans: {
        good: { cols: 2, rows: 2 },
        badCols: { cols: 7, rows: 1 },
        notRecord: 42,
      },
    })
    expect(migrated.paneSpans.good).toEqual({ cols: 2, rows: 2 })
    expect(migrated.paneSpans.badCols).toEqual({ cols: 1, rows: 1 })
    expect(migrated.paneSpans.notRecord).toBeUndefined()
  })

  test("filters non-string pinned entries", () => {
    const migrated = migrateKanbanPreferences({ pinned: ["/a\ns1", 7, null] })
    expect(migrated.pinned).toEqual(["/a\ns1"])
  })
})

describe("spanFor", () => {
  test("returns the stored span or a 1x1 default", () => {
    expect(spanFor({}, "any")).toEqual({ cols: 1, rows: 1 })
    expect(spanFor({ key: { cols: 2, rows: 1 } }, "key")).toEqual({ cols: 2, rows: 1 })
  })
})

describe("parsePaneSpan / paneSpanLabel", () => {
  test("round-trips every supported span", () => {
    for (const label of ["1x1", "2x1", "1x2", "2x2"]) {
      expect(paneSpanLabel(parsePaneSpan(label))).toBe(label)
    }
  })

  test("falls back to 1x1 for unknown labels", () => {
    expect(parsePaneSpan("9x9")).toEqual({ cols: 1, rows: 1 })
  })
})

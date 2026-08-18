import { describe, expect, test } from "bun:test"
import { defaultKanbanPreferences, migrateKanbanPreferences } from "../../../../src/components/kanban/model/preferences"

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

  test("keeps only the two known layout values", () => {
    expect(migrateKanbanPreferences({ layout: "focus" }).layout).toBe("focus")
    expect(migrateKanbanPreferences({ layout: "waterfall" }).layout).toBe("grid")
  })

  test("filters non-string pinned entries", () => {
    const migrated = migrateKanbanPreferences({ pinned: ["/a\ns1", 7, null] })
    expect(migrated.pinned).toEqual(["/a\ns1"])
  })

  test("drops retired free-layout fields from stored values", () => {
    const migrated = migrateKanbanPreferences({
      freeLayout: true,
      paneSpans: { key: { cols: 2, rows: 2 } },
    })
    expect(migrated).not.toHaveProperty("freeLayout")
    expect(migrated).not.toHaveProperty("paneSpans")
  })
})

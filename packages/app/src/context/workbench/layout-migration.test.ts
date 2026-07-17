import { describe, expect, test } from "bun:test"
import { migrateWorkbenchLayout } from "./layout-migration"

describe("migrateWorkbenchLayout", () => {
  test("migrates old workspace session state into side surface tabs", () => {
    const migrated = migrateWorkbenchLayout({
      workspaceSessions: {
        "home/session-1": {
          opened: true,
          active: "browser",
          width: 720,
          resized: true,
        },
      },
    }) as {
      workbenchSurfaces: Record<string, { side: { opened: boolean; active?: string; tabs: unknown[]; size?: number } }>
      workspaceSessions?: unknown
    }

    expect(migrated.workspaceSessions).toBeUndefined()
    expect(migrated.workbenchSurfaces["home/session-1"].side.opened).toBe(true)
    expect(migrated.workbenchSurfaces["home/session-1"].side.active).toBe("browser")
    expect(migrated.workbenchSurfaces["home/session-1"].side.tabs).toEqual([{ id: "browser", panelId: "browser" }])
    expect(migrated.workbenchSurfaces["home/session-1"].side.size).toBe(720)
  })

  test("does not restore old empty side workspaces as open launchers", () => {
    const migrated = migrateWorkbenchLayout({
      workspaceSessions: {
        "home/session-1": {
          opened: true,
          active: null,
          width: 720,
        },
      },
    }) as {
      workbenchSurfaces: Record<string, { side: { opened: boolean; active?: string; tabs: unknown[]; size?: number } }>
    }

    expect(migrated.workbenchSurfaces["home/session-1"].side.opened).toBe(false)
    expect(migrated.workbenchSurfaces["home/session-1"].side.active).toBeUndefined()
    expect(migrated.workbenchSurfaces["home/session-1"].side.tabs).toEqual([])
    expect(migrated.workbenchSurfaces["home/session-1"].side.size).toBe(720)
  })

  test("closes persisted workbench surfaces that have no tabs", () => {
    const migrated = migrateWorkbenchLayout({
      workbenchSurfaces: {
        "home/session-1": {
          side: { opened: true, active: "notes", tabs: [] },
          bottom: { opened: true, tabs: [{ id: "terminal:1", panelId: "terminal" }] },
        },
      },
    }) as {
      workbenchSurfaces: Record<string, { side: { opened: boolean }; bottom: { opened: boolean; active?: string } }>
    }

    expect(migrated.workbenchSurfaces["home/session-1"].side.opened).toBe(false)
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.opened).toBe(true)
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.active).toBe("terminal:1")
  })

  test("migrates old terminal height without restoring an empty bottom launcher", () => {
    const migrated = migrateWorkbenchLayout({
      terminal: { opened: true, height: 360 },
      workspaceSessions: {
        "home/session-1": { opened: false, active: null },
      },
    }) as {
      terminal?: unknown
      workbenchSurfaces: Record<string, { bottom: { opened: boolean; size?: number } }>
    }

    expect(migrated.terminal).toBeUndefined()
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.opened).toBe(false)
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.size).toBe(360)
  })

  test("drops unsupported persisted layout fields", () => {
    const migrated = migrateWorkbenchLayout({
      sidebar: { opened: true, width: 320 },
      obsoletePanelState: { opened: true },
    }) as Record<string, unknown>

    expect(migrated.sidebar).toEqual({ opened: true, width: 320 })
    expect(migrated.obsoletePanelState).toBeUndefined()
  })
})

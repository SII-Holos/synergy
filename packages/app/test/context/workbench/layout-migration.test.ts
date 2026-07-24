import { describe, expect, test } from "bun:test"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import { migrateWorkbenchLayout } from "../../../src/context/workbench/layout-migration"

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

  test("migrates legacy file tabs while dropping sessionTabs from current output", () => {
    const input = {
      sessionTabs: {
        "home/session-1": {
          opened: true,
          active: "file://src/app.ts",
          all: ["context", "file://src/app.ts", "file://tests/app.ts", "file://src/app.ts"],
        },
      },
      workbenchSurfaces: {
        "home/session-1": {
          side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
        },
      },
    }
    const migrated = migrateWorkbenchLayout(input) as {
      sessionTabs?: unknown
      workbenchSurfaces: Record<
        string,
        {
          side: { opened: boolean; active?: string; tabs: WorkbenchPanelTab[] }
        }
      >
    }

    expect(migrated.sessionTabs).toBeUndefined()
    expect(migrated.workbenchSurfaces["home/session-1"].side.opened).toBe(true)
    expect(migrated.workbenchSurfaces["home/session-1"].side.active).toBe("file:src/app.ts")
    expect(migrated.workbenchSurfaces["home/session-1"].side.tabs).toEqual([
      { id: "notes", panelId: "notes" },
      { id: "file:src/app.ts", panelId: "file", resourceId: "src/app.ts", title: "app.ts", source: "migration" },
      {
        id: "file:tests/app.ts",
        panelId: "file",
        resourceId: "tests/app.ts",
        title: "app.ts",
        source: "migration",
      },
    ])
    expect(migrateWorkbenchLayout(migrated)).toEqual(migrated)
  })

  test("does not let a legacy Context tab steal an existing side-panel activation", () => {
    const migrated = migrateWorkbenchLayout({
      sessionTabs: {
        "home/session-1": { active: "context", all: ["context", "file://README.md"] },
      },
      workbenchSurfaces: {
        "home/session-1": {
          side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
        },
      },
    }) as { workbenchSurfaces: Record<string, { side: { active?: string } }> }

    expect(migrated.workbenchSurfaces["home/session-1"].side.active).toBe("notes")
  })

  test("drops obsolete workspace discovery state without closing populated surfaces", () => {
    const migrated = migrateWorkbenchLayout({
      sidebar: { opened: false, width: 280 },
      sideWorkspaceDiscovered: false,
      workbenchSurfaces: {
        "home/session-1": {
          side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
        },
      },
    }) as Record<string, unknown>

    expect(migrated.sideWorkspaceDiscovered).toBeUndefined()
    expect(migrated.workbenchSurfaces).toEqual({
      "home/session-1": {
        side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
      },
    })
  })

  test("keeps the historical collapsed navigation default for legacy layouts without sidebar state", () => {
    const migrated = migrateWorkbenchLayout({ review: { diffStyle: "split" } }) as Record<string, unknown>

    expect(migrated.sidebar).toEqual({ opened: false })
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

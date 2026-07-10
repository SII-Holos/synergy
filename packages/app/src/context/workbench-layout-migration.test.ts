import { describe, expect, test } from "bun:test"
import { migrateWorkbenchLayout } from "./workbench-layout-migration"

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

  test("moves legacy file tabs into the side workspace and leaves Context isolated", () => {
    const migrated = migrateWorkbenchLayout({
      sessionTabs: {
        "repo/session-1": {
          active: "file://src/app.ts",
          all: ["context", "file://src/app.ts", "file://tests/app.ts", "file://src/app.ts"],
        },
      },
      workbenchSurfaces: {
        "repo/session-1": {
          side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
        },
      },
    }) as {
      sessionTabs: Record<string, { active?: string; all: string[] }>
      workbenchSurfaces: Record<
        string,
        {
          side: {
            opened: boolean
            active?: string
            tabs: Array<{ id: string; panelId: string; resourceId?: string; title?: string; source?: string }>
          }
        }
      >
    }

    expect(migrated.sessionTabs["repo/session-1"]).toEqual({ active: "context", all: ["context"] })
    expect(migrated.workbenchSurfaces["repo/session-1"].side.opened).toBe(true)
    expect(migrated.workbenchSurfaces["repo/session-1"].side.active).toBe("file:src/app.ts")
    expect(migrated.workbenchSurfaces["repo/session-1"].side.tabs).toEqual([
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

  test("does not steal side workspace activation when Context was active", () => {
    const migrated = migrateWorkbenchLayout({
      sessionTabs: {
        "repo/session-1": { active: "context", all: ["context", "file://README.md"] },
      },
      workbenchSurfaces: {
        "repo/session-1": {
          side: { opened: true, active: "notes", tabs: [{ id: "notes", panelId: "notes" }] },
        },
      },
    }) as {
      workbenchSurfaces: Record<string, { side: { active?: string } }>
    }

    expect(migrated.workbenchSurfaces["repo/session-1"].side.active).toBe("notes")
  })
})

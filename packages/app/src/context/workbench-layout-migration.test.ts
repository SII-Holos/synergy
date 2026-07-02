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

  test("migrates old terminal height into bottom surface state", () => {
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
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.opened).toBe(true)
    expect(migrated.workbenchSurfaces["home/session-1"].bottom.size).toBe(360)
  })
})

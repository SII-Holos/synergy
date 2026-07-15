import { describe, expect, test } from "bun:test"
import {
  applyDesktopUnreadUpdate,
  desktopUnreadAssetPaths,
  desktopUnreadPresentation,
} from "../src/unread-indicator.js"

describe("desktop unread indicator", () => {
  test("uses a numeric macOS Dock badge capped at 99+", () => {
    expect(desktopUnreadPresentation("darwin", 7, "Synergy")).toEqual({
      dockBadge: "7",
      launcherBadgeCount: undefined,
      overlayVisible: false,
      overlayDescription: "7 unread Synergy sessions",
      trayUnread: false,
      trayTooltip: "Synergy",
    })
    expect(desktopUnreadPresentation("darwin", 125, "Synergy").dockBadge).toBe("99+")
    expect(desktopUnreadPresentation("darwin", 0, "Synergy").dockBadge).toBe("")
  })

  test("uses a Windows taskbar dot with an exact accessible count", () => {
    expect(desktopUnreadPresentation("win32", 1, "Synergy")).toEqual({
      dockBadge: undefined,
      launcherBadgeCount: undefined,
      overlayVisible: true,
      overlayDescription: "1 unread Synergy session",
      trayUnread: false,
      trayTooltip: "Synergy",
    })
    expect(desktopUnreadPresentation("win32", 0, "Synergy").overlayVisible).toBe(false)
  })

  test("uses the Linux launcher count and tray fallback", () => {
    expect(desktopUnreadPresentation("linux", 12, "Synergy")).toEqual({
      dockBadge: undefined,
      launcherBadgeCount: 12,
      overlayVisible: false,
      overlayDescription: "12 unread Synergy sessions",
      trayUnread: true,
      trayTooltip: "Synergy — 12 unread sessions",
    })
    expect(desktopUnreadPresentation("linux", 0, "Synergy").trayTooltip).toBe("Synergy")
  })

  test("resolves packaged and development unread assets", () => {
    expect(
      desktopUnreadAssetPaths({
        platform: "win32",
        dirname: "C:\\app\\dist",
        isPackaged: true,
        resourcesPath: "C:\\app\\resources",
      }),
    ).toEqual({
      overlay: "C:\\app\\resources\\icons\\unread-overlay.png",
      trayUnread: "C:\\app\\resources\\icons\\icon-unread.png",
    })
    expect(
      desktopUnreadAssetPaths({
        platform: "linux",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toEqual({
      overlay: "/app/build/unread-overlay.png",
      trayUnread: "/app/build/icon-unread.png",
    })
  })

  test("accepts badge updates only from the main renderer", () => {
    const webContents = {}
    const counts: number[] = []
    const input = {
      mainWindow: { webContents },
      rawState: { count: 3 },
      setCount: (count: number) => counts.push(count),
    }

    expect(() => applyDesktopUnreadUpdate({ ...input, sender: {} })).toThrow("not trusted")
    expect(() => applyDesktopUnreadUpdate({ ...input, sender: webContents })).not.toThrow()
    expect(counts).toEqual([3])
  })
})

import path from "node:path"
import { parseDesktopBadgeState } from "./ipc-contract.js"

export interface DesktopUnreadPresentation {
  dockBadge?: string
  launcherBadgeCount?: number
  overlayVisible: boolean
  overlayDescription: string
  trayUnread: boolean
  trayTooltip: string
}

export interface DesktopUnreadAssetPaths {
  overlay?: string
  trayUnread?: string
}

export interface DesktopUnreadAssetOptions {
  platform: NodeJS.Platform
  dirname: string
  isPackaged: boolean
  resourcesPath: string
}

function unreadCompletionsLabel(count: number): string {
  return `${count} unread Synergy completion${count === 1 ? "" : "s"}`
}

export function desktopUnreadPresentation(
  platform: NodeJS.Platform,
  count: number,
  windowTitle: string,
): DesktopUnreadPresentation {
  const unread = count > 0
  const description = unread ? unreadCompletionsLabel(count) : ""
  return {
    dockBadge: platform === "darwin" ? (unread ? (count > 99 ? "99+" : String(count)) : "") : undefined,
    launcherBadgeCount: platform === "linux" ? count : undefined,
    overlayVisible: platform === "win32" && unread,
    overlayDescription: description,
    trayUnread: platform === "linux" && unread,
    trayTooltip:
      platform === "linux" && unread
        ? `${windowTitle} — ${count} unread completion${count === 1 ? "" : "s"}`
        : windowTitle,
  }
}

export function desktopUnreadAssetPaths(options: DesktopUnreadAssetOptions): DesktopUnreadAssetPaths {
  if (options.platform !== "win32" && options.platform !== "linux") return {}
  const platformPath = options.platform === "win32" ? path.win32 : path.posix
  const root = options.isPackaged
    ? platformPath.resolve(options.resourcesPath, "icons")
    : platformPath.resolve(options.dirname, "..", "build")
  return {
    overlay: platformPath.resolve(root, "unread-overlay.png"),
    trayUnread: platformPath.resolve(root, "icon-unread.png"),
  }
}

export function applyDesktopUnreadUpdate(input: {
  mainWindow: { webContents: object } | null
  sender: object
  rawState: unknown
  setCount(count: number): void
}): void {
  if (!input.mainWindow || input.sender !== input.mainWindow.webContents) {
    throw new Error("Desktop badge IPC sender is not trusted.")
  }
  const state = parseDesktopBadgeState(input.rawState)
  input.setCount(state.count)
}

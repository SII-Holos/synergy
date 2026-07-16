import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"
import path from "node:path"

export interface DesktopWindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

export interface DesktopWindowChromeOptions {
  platform: NodeJS.Platform
  dirname: string
  isPackaged: boolean
  resourcesPath: string
}

export interface DesktopCloseBehaviorOptions {
  platform: NodeJS.Platform
  trayAvailable: boolean
  isQuitting: boolean
  isUpdateQuit: boolean
}

export function desktopWindowChromeOptions(
  options: DesktopWindowChromeOptions,
): Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "frame" | "icon" | "titleBarStyle" | "trafficLightPosition"
> {
  if (options.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
    }
  }

  return {
    autoHideMenuBar: true,
    frame: false,
    icon: desktopIconPath(options),
  }
}

export function desktopDevIconPath(platform: NodeJS.Platform, dirname: string): string | undefined {
  if (platform === "win32") return path.win32.resolve(dirname, "..", "build", "icon.ico")
  if (platform === "linux") return path.posix.resolve(dirname, "..", "build", "icon.png")
  return undefined
}

export function desktopIconPath(options: DesktopWindowChromeOptions): string | undefined {
  if (!options.isPackaged) return desktopDevIconPath(options.platform, options.dirname)
  if (options.platform === "win32") return path.win32.resolve(options.resourcesPath, "icons", "icon.ico")
  if (options.platform === "linux") return path.posix.resolve(options.resourcesPath, "icons", "icon.png")
  return undefined
}

export function desktopStartupIconPath(options: DesktopWindowChromeOptions): string {
  const platformPath = options.platform === "win32" ? path.win32 : path.posix
  if (options.isPackaged) return platformPath.resolve(options.resourcesPath, "icons", "icon.png")
  return platformPath.resolve(options.dirname, "..", "build", "icon.png")
}

export function desktopUsesSystemTray(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux"
}

export function desktopShouldHideToTray(options: DesktopCloseBehaviorOptions): boolean {
  if (!desktopUsesSystemTray(options.platform)) return false
  if (!options.trayAvailable) return false
  if (options.isQuitting || options.isUpdateQuit) return false
  return true
}

export function desktopDevDockIconPath(options: DesktopWindowChromeOptions): string | undefined {
  if (options.isPackaged) return undefined
  if (options.platform !== "darwin") return undefined
  return path.posix.resolve(options.dirname, "..", "build", "icon.png")
}

export function desktopEmitsWindowStateEvents(platform: NodeJS.Platform): boolean {
  return platform !== "darwin"
}

export function desktopWindowState(window: BrowserWindow): DesktopWindowState {
  return {
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    focused: window.isFocused(),
  }
}

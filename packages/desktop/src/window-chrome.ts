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
    icon: options.isPackaged ? undefined : desktopDevIconPath(options.platform, options.dirname),
  }
}

export function desktopDevIconPath(platform: NodeJS.Platform, dirname: string): string | undefined {
  if (platform === "win32") return path.win32.resolve(dirname, "..", "build", "icon.ico")
  if (platform === "linux") return path.posix.resolve(dirname, "..", "build", "icon.png")
  return undefined
}

export function desktopWindowState(window: BrowserWindow): DesktopWindowState {
  return {
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    focused: window.isFocused(),
  }
}

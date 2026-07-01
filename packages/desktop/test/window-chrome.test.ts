import { describe, expect, test } from "bun:test"
import type { BrowserWindow } from "electron"
import { desktopDevIconPath, desktopWindowChromeOptions, desktopWindowState } from "../src/window-chrome.js"

describe("desktop window chrome", () => {
  test("uses custom chrome on Windows and Linux development windows", () => {
    expect(desktopWindowChromeOptions({ platform: "win32", dirname: "C:\\app\\dist", isPackaged: false })).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "C:\\app\\build\\icon.ico",
    })

    expect(desktopWindowChromeOptions({ platform: "linux", dirname: "/app/dist", isPackaged: false })).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "/app/build/icon.png",
    })
  })

  test("does not depend on development icon paths once packaged", () => {
    expect(desktopWindowChromeOptions({ platform: "win32", dirname: "C:\\app\\dist", isPackaged: true })).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: undefined,
    })
  })

  test("keeps macOS on the native inset titlebar path", () => {
    expect(desktopWindowChromeOptions({ platform: "darwin", dirname: "/app/dist", isPackaged: false })).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
    })
    expect(desktopDevIconPath("darwin", "/app/dist")).toBeUndefined()
  })

  test("returns the safe renderer-facing window state", () => {
    const state = desktopWindowState({
      isMaximized: () => true,
      isFullScreen: () => false,
      isFocused: () => true,
    } as BrowserWindow)

    expect(state).toEqual({
      maximized: true,
      fullscreen: false,
      focused: true,
    })
  })
})

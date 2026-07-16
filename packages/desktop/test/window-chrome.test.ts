import { describe, expect, test } from "bun:test"
import type { BrowserWindow } from "electron"
import {
  desktopDevDockIconPath,
  desktopDevIconPath,
  desktopShouldHideToTray,
  desktopStartupIconPath,
  desktopUsesSystemTray,
  desktopWindowChromeOptions,
  desktopEmitsWindowStateEvents,
  desktopWindowState,
} from "../src/window-chrome.js"

describe("desktop window chrome", () => {
  test("uses custom chrome on Windows and Linux development windows", () => {
    expect(
      desktopWindowChromeOptions({
        platform: "win32",
        dirname: "C:\\app\\dist",
        isPackaged: false,
        resourcesPath: "C:\\app\\resources",
      }),
    ).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "C:\\app\\build\\icon.ico",
    })

    expect(
      desktopWindowChromeOptions({
        platform: "linux",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "/app/build/icon.png",
    })
  })

  test("uses packaged runtime icon resources on Windows and Linux", () => {
    expect(
      desktopWindowChromeOptions({
        platform: "win32",
        dirname: "C:\\app\\dist",
        isPackaged: true,
        resourcesPath: "C:\\app\\resources",
      }),
    ).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "C:\\app\\resources\\icons\\icon.ico",
    })

    expect(
      desktopWindowChromeOptions({
        platform: "linux",
        dirname: "/app/dist",
        isPackaged: true,
        resourcesPath: "/app/resources",
      }),
    ).toEqual({
      autoHideMenuBar: true,
      frame: false,
      icon: "/app/resources/icons/icon.png",
    })
  })

  test("keeps macOS on the native inset titlebar path", () => {
    expect(
      desktopWindowChromeOptions({
        platform: "darwin",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
    })
    expect(desktopDevIconPath("darwin", "/app/dist")).toBeUndefined()
  })

  test("uses the product icon for the macOS development Dock item", () => {
    expect(
      desktopDevDockIconPath({
        platform: "darwin",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toBe("/app/build/icon.png")
    expect(
      desktopDevDockIconPath({
        platform: "darwin",
        dirname: "/app/dist",
        isPackaged: true,
        resourcesPath: "/resources",
      }),
    ).toBeUndefined()
    expect(
      desktopDevDockIconPath({
        platform: "linux",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toBeUndefined()
  })

  test("uses PNG resources for the startup splash icon", () => {
    expect(
      desktopStartupIconPath({
        platform: "win32",
        dirname: "C:\\app\\dist",
        isPackaged: false,
        resourcesPath: "C:\\app\\resources",
      }),
    ).toBe("C:\\app\\build\\icon.png")
    expect(
      desktopStartupIconPath({
        platform: "win32",
        dirname: "C:\\app\\dist",
        isPackaged: true,
        resourcesPath: "C:\\app\\resources",
      }),
    ).toBe("C:\\app\\resources\\icons\\icon.png")
    expect(
      desktopStartupIconPath({
        platform: "linux",
        dirname: "/app/dist",
        isPackaged: false,
        resourcesPath: "/resources",
      }),
    ).toBe("/app/build/icon.png")
  })

  test("keeps Windows and Linux desktop sessions reopenable from the tray", () => {
    expect(desktopUsesSystemTray("win32")).toBe(true)
    expect(desktopUsesSystemTray("linux")).toBe(true)
    expect(desktopUsesSystemTray("darwin")).toBe(false)

    expect(
      desktopShouldHideToTray({
        platform: "win32",
        trayAvailable: true,
        isQuitting: false,
        isUpdateQuit: false,
      }),
    ).toBe(true)
    expect(
      desktopShouldHideToTray({
        platform: "linux",
        trayAvailable: true,
        isQuitting: false,
        isUpdateQuit: false,
      }),
    ).toBe(true)
  })

  test("does not hide to tray while the app is actually quitting", () => {
    expect(
      desktopShouldHideToTray({
        platform: "win32",
        trayAvailable: false,
        isQuitting: false,
        isUpdateQuit: false,
      }),
    ).toBe(false)
    expect(
      desktopShouldHideToTray({
        platform: "win32",
        trayAvailable: true,
        isQuitting: true,
        isUpdateQuit: false,
      }),
    ).toBe(false)
    expect(
      desktopShouldHideToTray({
        platform: "win32",
        trayAvailable: true,
        isQuitting: false,
        isUpdateQuit: true,
      }),
    ).toBe(false)
  })

  test("does not broadcast native macOS fullscreen transitions to the renderer", () => {
    expect(desktopEmitsWindowStateEvents("darwin")).toBe(false)
    expect(desktopEmitsWindowStateEvents("win32")).toBe(true)
    expect(desktopEmitsWindowStateEvents("linux")).toBe(true)
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

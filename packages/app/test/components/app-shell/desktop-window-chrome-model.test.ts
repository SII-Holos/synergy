import { describe, expect, test } from "bun:test"
import {
  desktopWindowChromeVisible,
  desktopWindowNativeChromeActive,
  desktopWindowToggleIcon,
  desktopWindowToggleLabel,
} from "../../../src/components/app-shell/desktop-window-chrome-model"

function msg(d: { message?: string }): string {
  return d.message ?? ""
}

describe("desktop window chrome model", () => {
  test("shows only for desktop shells with a window bridge", () => {
    const bridge = {
      chrome: "custom" as const,
      minimize: async () => {},
      toggleMaximize: async () => null,
      close: async () => {},
      state: async () => null,
    }
    const nativeBridge = { ...bridge, chrome: "native" as const }

    expect(desktopWindowChromeVisible({ platform: "desktop", desktopWindow: bridge })).toBe(true)
    expect(desktopWindowChromeVisible({ platform: "desktop", desktopWindow: nativeBridge })).toBe(false)
    expect(desktopWindowChromeVisible({ platform: "desktop" })).toBe(false)
    expect(desktopWindowChromeVisible({ platform: "web", desktopWindow: bridge })).toBe(false)
  })

  test("marks only desktop shells with native chrome as native chrome surfaces", () => {
    const bridge = {
      chrome: "custom" as const,
      minimize: async () => {},
      toggleMaximize: async () => null,
      close: async () => {},
      state: async () => null,
    }
    const nativeBridge = { ...bridge, chrome: "native" as const }

    expect(desktopWindowNativeChromeActive({ platform: "desktop", desktopWindow: nativeBridge })).toBe(true)
    expect(desktopWindowNativeChromeActive({ platform: "desktop", desktopWindow: bridge })).toBe(false)
    expect(desktopWindowNativeChromeActive({ platform: "desktop" })).toBe(false)
    expect(desktopWindowNativeChromeActive({ platform: "web", desktopWindow: nativeBridge })).toBe(false)
  })

  test("uses maximize until the window is maximized or fullscreen", () => {
    expect(desktopWindowToggleIcon(null)).toBe("window.maximize")
    expect(msg(desktopWindowToggleLabel(null))).toBe("Maximize")
    expect(desktopWindowToggleIcon({ maximized: false, fullscreen: false, focused: true })).toBe("window.maximize")
    expect(msg(desktopWindowToggleLabel({ maximized: false, fullscreen: false, focused: true }))).toBe("Maximize")
  })

  test("uses restore for maximized and fullscreen windows", () => {
    expect(desktopWindowToggleIcon({ maximized: true, fullscreen: false, focused: true })).toBe("window.restore")
    expect(msg(desktopWindowToggleLabel({ maximized: true, fullscreen: false, focused: true }))).toBe("Restore")
    expect(desktopWindowToggleIcon({ maximized: false, fullscreen: true, focused: true })).toBe("window.restore")
    expect(msg(desktopWindowToggleLabel({ maximized: false, fullscreen: true, focused: true }))).toBe("Restore")
  })
})

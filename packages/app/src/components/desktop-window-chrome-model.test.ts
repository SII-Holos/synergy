import { describe, expect, test } from "bun:test"
import {
  desktopWindowChromeVisible,
  desktopWindowToggleIcon,
  desktopWindowToggleLabel,
} from "@/components/desktop-window-chrome-model"

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

  test("uses maximize until the window is maximized or fullscreen", () => {
    expect(desktopWindowToggleIcon(null)).toBe("window.maximize")
    expect(desktopWindowToggleLabel(null)).toBe("Maximize")
    expect(desktopWindowToggleIcon({ maximized: false, fullscreen: false, focused: true })).toBe("window.maximize")
    expect(desktopWindowToggleLabel({ maximized: false, fullscreen: false, focused: true })).toBe("Maximize")
  })

  test("uses restore for maximized and fullscreen windows", () => {
    expect(desktopWindowToggleIcon({ maximized: true, fullscreen: false, focused: true })).toBe("window.restore")
    expect(desktopWindowToggleLabel({ maximized: true, fullscreen: false, focused: true })).toBe("Restore")
    expect(desktopWindowToggleIcon({ maximized: false, fullscreen: true, focused: true })).toBe("window.restore")
    expect(desktopWindowToggleLabel({ maximized: false, fullscreen: true, focused: true })).toBe("Restore")
  })
})

import { describe, expect, test } from "bun:test"
import {
  DESKTOP_APP_ID,
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_PROTOCOL,
  desktopAppUserModelId,
  desktopChannel,
  desktopServerMode,
  desktopWindowTitle,
} from "../src/identity.js"

describe("desktop identity", () => {
  test("uses the production app identity", () => {
    expect(DESKTOP_APP_ID).toBe("io.holosai.synergy")
    expect(DESKTOP_EXECUTABLE_NAME).toBe("synergy")
    expect(DESKTOP_PROTOCOL).toBe("synergy")
  })

  test("defaults to stable only when packaged", () => {
    const previous = process.env.SYNERGY_DESKTOP_CHANNEL
    delete process.env.SYNERGY_DESKTOP_CHANNEL
    expect(desktopChannel(false)).toBe("dev")
    expect(desktopChannel(true)).toBe("stable")
    restoreEnv("SYNERGY_DESKTOP_CHANNEL", previous)
  })

  test("uses managed server mode unless dev provides an external URL", () => {
    const previousMode = process.env.SYNERGY_DESKTOP_SERVER_MODE
    const previousURL = process.env.SYNERGY_DESKTOP_APP_URL
    delete process.env.SYNERGY_DESKTOP_SERVER_MODE
    delete process.env.SYNERGY_DESKTOP_APP_URL
    expect(desktopServerMode("stable")).toBe("managed")
    expect(desktopServerMode("dev")).toBe("managed")
    process.env.SYNERGY_DESKTOP_APP_URL = "http://localhost:3000"
    expect(desktopServerMode("dev")).toBe("external")
    expect(desktopServerMode("stable")).toBe("managed")
    restoreEnv("SYNERGY_DESKTOP_SERVER_MODE", previousMode)
    restoreEnv("SYNERGY_DESKTOP_APP_URL", previousURL)
  })

  test("marks dev windows explicitly", () => {
    expect(desktopWindowTitle("dev")).toBe("Synergy Dev")
    expect(desktopWindowTitle("stable")).toBe("Synergy")
  })

  test("keeps Windows taskbar identity separate for development", () => {
    expect(desktopAppUserModelId("stable")).toBe("io.holosai.synergy")
    expect(desktopAppUserModelId("dev")).toBe("io.holosai.synergy.dev")
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

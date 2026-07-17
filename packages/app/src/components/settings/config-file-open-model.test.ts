import { describe, expect, test } from "bun:test"
import { setupI18n, type MessageDescriptor } from "@lingui/core"
import { canUseConfigFileOpen, configFileOpenFailure } from "./config-file-open-model"
import type { DesktopServerStatus, Platform } from "@/context/platform"

const managedRunningStatus: DesktopServerStatus = {
  mode: "managed",
  state: "running",
  url: "http://127.0.0.1:3000",
  port: 3000,
  pid: 123,
  lastError: null,
  logFile: null,
}

function platform(overrides: Partial<Platform> = {}): Platform {
  return {
    platform: "desktop",
    openLink() {},
    restart: async () => {},
    notify: async () => {},
    desktopServer: {
      status: async () => managedRunningStatus,
      restart: async () => managedRunningStatus,
    },
    ...overrides,
  }
}

function render(descriptor: MessageDescriptor): string {
  const i18n = setupI18n({ locale: "en" })
  return i18n._(descriptor)
}

describe("config file open model", () => {
  test("surfaces structured opener failures with the config path and recovery action", () => {
    const failure = configFileOpenFailure(
      {
        success: false,
        error: "ConfigDomainOpenOpenerMissingError",
        message: 'Required opener "xdg-open" was not found',
        path: "/srv/synergy/config/synergy.d/00-general.jsonc",
      },
      "/fallback/00-general.jsonc",
    )

    expect(render(failure.title)).toBe("Could not open config file")
    expect(render(failure.description)).toContain('Required opener "xdg-open" was not found')
    expect(render(failure.description)).toContain("/srv/synergy/config/synergy.d/00-general.jsonc")
    expect(render(failure.description)).toContain("Copy Path")
  })

  test("uses the known domain path when opening throws an Error", () => {
    const failure = configFileOpenFailure(new Error("No application is registered"), "/config/10-models.jsonc")

    expect(render(failure.description)).toContain("No application is registered")
    expect(render(failure.description)).toContain("/config/10-models.jsonc")
  })

  test("uses an actionable fallback for unknown failures", () => {
    const failure = configFileOpenFailure(null, "/config/20-providers.jsonc")

    expect(render(failure.description)).toContain("server could not open")
    expect(render(failure.description)).toContain("/config/20-providers.jsonc")
    expect(render(failure.description)).toContain("Copy Path")
  })

  test("allows Open File only for a running managed Desktop server", () => {
    expect(canUseConfigFileOpen(platform(), managedRunningStatus)).toBe(true)
    expect(canUseConfigFileOpen(platform({ platform: "web" }), managedRunningStatus)).toBe(false)
    expect(canUseConfigFileOpen(platform(), { ...managedRunningStatus, mode: "external", state: "external" })).toBe(
      false,
    )
    expect(canUseConfigFileOpen(platform(), { ...managedRunningStatus, state: "starting" })).toBe(false)
    expect(canUseConfigFileOpen(platform({ desktopServer: undefined }), managedRunningStatus)).toBe(false)
    expect(canUseConfigFileOpen(platform(), null)).toBe(false)
  })
})

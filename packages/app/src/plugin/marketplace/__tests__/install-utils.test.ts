import { describe, test, expect } from "bun:test"
import { semverGt, checkUpdateAvailable, getInstalledVersion } from "../install-utils"
import type { ApiPluginInfo } from "@ericsanchezok/synergy-sdk/client"

describe("semverGt", () => {
  test("1.2.0 > 1.1.0", () => {
    expect(semverGt("1.2.0", "1.1.0")).toBe(true)
  })

  test("2.0.0 > 1.9.9", () => {
    expect(semverGt("2.0.0", "1.9.9")).toBe(true)
  })

  test("1.0.0 is NOT > 1.0.0", () => {
    expect(semverGt("1.0.0", "1.0.0")).toBe(false)
  })

  test("1.0.0 is NOT > 2.0.0", () => {
    expect(semverGt("1.0.0", "2.0.0")).toBe(false)
  })

  test("1.0.1 > 1.0.0", () => {
    expect(semverGt("1.0.1", "1.0.0")).toBe(true)
  })

  test("1.10.0 > 1.9.0", () => {
    expect(semverGt("1.10.0", "1.9.0")).toBe(true)
  })

  test("handles different segment lengths: 1.2 > 1.1.0", () => {
    expect(semverGt("1.2", "1.1.0")).toBe(true)
  })

  test("1.1.0 is NOT > 1.2", () => {
    expect(semverGt("1.1.0", "1.2")).toBe(false)
  })

  test("handles zero versions: 0.0.1 > 0.0.0", () => {
    expect(semverGt("0.0.1", "0.0.0")).toBe(true)
  })
})

describe("checkUpdateAvailable", () => {
  test("null installedVersion means update available", () => {
    expect(checkUpdateAvailable("1.0.0", null)).toBe(true)
  })

  test("same version means no update", () => {
    expect(checkUpdateAvailable("1.0.0", "1.0.0")).toBe(false)
  })

  test("registry version is newer means update available", () => {
    expect(checkUpdateAvailable("2.0.0", "1.0.0")).toBe(true)
  })

  test("registry version is older means no update", () => {
    expect(checkUpdateAvailable("1.0.0", "2.0.0")).toBe(false)
  })

  test("patch bump means update available", () => {
    expect(checkUpdateAvailable("1.0.1", "1.0.0")).toBe(true)
  })

  test("minor bump means update available", () => {
    expect(checkUpdateAvailable("1.1.0", "1.0.5")).toBe(true)
  })

  test("empty registryVersion means no update", () => {
    expect(checkUpdateAvailable("", "0.0.0")).toBe(false)
  })

  test("undefined registryVersion means no update", () => {
    expect(checkUpdateAvailable(undefined as unknown as string, "0.0.0")).toBe(false)
  })
})

describe("getInstalledVersion", () => {
  function makePlugin(overrides: Partial<ApiPluginInfo> & { pluginId: string }): ApiPluginInfo {
    const { pluginId, ...rest } = overrides
    return {
      pluginId,
      name: pluginId,
      version: "1.0.0",
      trustTier: "trusted-import",
      hasManifest: true,
      pluginDir: `/tmp/${pluginId}`,
      cliCommands: [],
      skillCount: 0,
      agentCount: 0,
      ...rest,
    }
  }

  test("finds plugin by exact pluginId", () => {
    const plugins = [
      makePlugin({ pluginId: "test-plugin", version: "2.3.1" }),
      makePlugin({ pluginId: "other-plugin", version: "1.0.0" }),
    ]
    expect(getInstalledVersion(plugins, "test-plugin")).toBe("2.3.1")
  })

  test("finds plugin by name match when no pluginId match", () => {
    const plugins = [makePlugin({ pluginId: "npm--@scope--test-plugin", name: "test-plugin", version: "2.3.1" })]
    expect(getInstalledVersion(plugins, "test-plugin")).toBe("2.3.1")
  })

  test("returns null when no match", () => {
    const plugins = [makePlugin({ pluginId: "other", name: "other", version: "1.0.0" })]
    expect(getInstalledVersion(plugins, "test-plugin")).toBeNull()
  })

  test("returns null for empty plugins array", () => {
    expect(getInstalledVersion([], "test-plugin")).toBeNull()
  })

  test("prefers exact pluginId match over name match", () => {
    const plugins = [
      makePlugin({ pluginId: "exact-match", version: "2.0.0" }),
      makePlugin({ pluginId: "other", name: "also-exact-match", version: "1.0.0" }),
    ]
    expect(getInstalledVersion(plugins, "exact-match")).toBe("2.0.0")
  })

  test("returns null when version is undefined", () => {
    const plugins = [{ ...makePlugin({ pluginId: "no-version" }), version: undefined! }]
    expect(getInstalledVersion(plugins, "no-version")).toBeNull()
  })

  test("returns null when version is 0.0.0 (never loaded)", () => {
    const plugins = [makePlugin({ pluginId: "unresolved", version: "0.0.0" })]
    expect(getInstalledVersion(plugins, "unresolved")).toBeNull()
  })
})

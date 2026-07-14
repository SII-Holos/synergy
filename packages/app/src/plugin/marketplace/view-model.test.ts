import { describe, expect, test } from "bun:test"
import type { InstalledPlugin } from "./types"
import {
  installationLabel,
  installedPluginFromSnapshot,
  installedPluginsForView,
  isDevelopmentPlugin,
  MARKETPLACE_NAV_ITEMS,
} from "./view-model"

function plugin(input: Partial<InstalledPlugin> & Pick<InstalledPlugin, "id" | "installation">): InstalledPlugin {
  const { id, installation, ...overrides } = input
  return {
    id,
    name: input.name ?? id,
    installation,
    trust: "declarative",
    health: "loaded",
    loaded: true,
    capabilities: [],
    risk: "low",
    operations: [],
    tools: [],
    uiContributions: 0,
    contributionHealth: {},
    ...overrides,
  }
}

describe("plugin marketplace views", () => {
  const directory = plugin({
    id: "focus",
    version: "0.1.0",
    installation: { kind: "directory", spec: "file:///focus/dist", path: "C:\\focus\\dist" },
  })
  const official = plugin({
    id: "official-plugin",
    installation: { kind: "registry", registry: "official", spec: "file:///registry/plugin.tgz" },
  })

  test("Development contains directory registrations while Installed contains both", () => {
    expect(MARKETPLACE_NAV_ITEMS).toEqual([
      { id: "discover", label: "Discover" },
      { id: "installed", label: "Installed" },
      { id: "development", label: "Development" },
    ])
    expect(isDevelopmentPlugin(directory)).toBe(true)
    expect(isDevelopmentPlugin(official)).toBe(false)
    expect(installedPluginsForView([directory, official], "development", "").map((item) => item.id)).toEqual(["focus"])
    expect(installedPluginsForView([directory, official], "installed", "").map((item) => item.id)).toEqual([
      "focus",
      "official-plugin",
    ])
  })

  test("search includes directory paths and installation labels are explicit", () => {
    expect(installedPluginsForView([directory, official], "development", "focus\\dist")).toEqual([directory])
    expect(installationLabel(directory)).toBe("Local directory")
    expect(installationLabel(official)).toBe("Official registry")
  })

  test("uses the opening snapshot only until the authoritative installed list arrives", () => {
    expect(installedPluginFromSnapshot("focus", undefined, directory)).toBe(directory)
    expect(installedPluginFromSnapshot("focus", [], directory)).toBeUndefined()
    expect(installedPluginFromSnapshot("focus", [official, directory], official)).toBe(directory)
  })
})

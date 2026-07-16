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

describe("plugin content pass-through boundary", () => {
  test("installationLabel returns plain strings suitable for i18n descriptor wrapping", () => {
    const labels = [
      installationLabel(plugin({ id: "a", installation: { kind: "directory", spec: "s", path: "p" } })),
      installationLabel(plugin({ id: "b", installation: { kind: "archive", spec: "s", path: "p" } })),
      installationLabel(plugin({ id: "c", installation: { kind: "registry", registry: "official", spec: "s" } })),
      installationLabel(plugin({ id: "d", installation: { kind: "registry", registry: "local", spec: "s" } })),
      installationLabel(plugin({ id: "e", installation: { kind: "package", source: "npm", spec: "s" } })),
      installationLabel(plugin({ id: "f", installation: { kind: "package", source: "git", spec: "s" } })),
      installationLabel(plugin({ id: "g", installation: { kind: "builtin", spec: "s" } })),
    ]
    for (const label of labels) {
      expect(typeof label).toBe("string")
      expect(label.length).toBeGreaterThan(0)
    }
  })

  test("installationLabel never includes plugin id or name in the label", () => {
    const p = plugin({
      id: "my-unique-plugin-xyz",
      name: "Plugin Name",
      installation: { kind: "directory", spec: "s", path: "/tmp/x" },
    })
    const label = installationLabel(p)
    expect(label).not.toContain("my-unique-plugin-xyz")
    expect(label).not.toContain("Plugin Name")
    expect(label).toBe("Local directory")
  })

  test("installationLabel for registry uses canonical labels without naming the plugin", () => {
    const official = plugin({ id: "ghost", installation: { kind: "registry", registry: "official", spec: "s" } })
    const local = plugin({ id: "alias", installation: { kind: "registry", registry: "local", spec: "s" } })
    expect(installationLabel(official)).toBe("Official registry")
    expect(installationLabel(local)).toBe("Local registry")
  })

  test("installedPluginFromSnapshot never fabricates plugin data and preserves identity", () => {
    const snap = plugin({ id: "abc", version: "2.0.0", installation: { kind: "directory", spec: "s", path: "p" } })
    expect(installedPluginFromSnapshot("abc", undefined, snap)).toBe(snap)
    expect(installedPluginFromSnapshot("abc", [], snap)).toBeUndefined()
    const authoritative = plugin({
      id: "abc",
      version: "1.0.0",
      installation: { kind: "archive", spec: "s", path: "p" },
    })
    expect(installedPluginFromSnapshot("abc", [authoritative], snap)).toBe(authoritative)
  })

  test("installedPluginsForView filters by view type but preserves all plugin data fields", () => {
    const dev = plugin({ id: "dev1", installation: { kind: "directory", spec: "s", path: "/x" } })
    const installed = plugin({ id: "reg1", installation: { kind: "registry", registry: "official", spec: "s" } })
    const results = installedPluginsForView([dev, installed], "development", "")
    expect(results).toHaveLength(1)
    expect(results[0]).toBe(dev)
    expect(results[0].id).toBe("dev1")
    expect(results[0].risk).toBe("low")
    expect(results[0].installation.kind).toBe("directory")
  })
})

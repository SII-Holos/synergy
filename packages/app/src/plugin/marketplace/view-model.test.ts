import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { pluginMarketplace } from "@/locales/messages"
import type { InstalledPlugin } from "./types"
import {
  installationLabel,
  installedPluginFromSnapshot,
  installedPluginStatusView,
  installedPluginsForView,
  isApprovalDisabledPlugin,
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
      { id: "discover", label: pluginMarketplace.navDiscover },
      { id: "installed", label: pluginMarketplace.navInstalled },
      { id: "development", label: pluginMarketplace.navDevelopment },
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
    expect(installationLabel(directory)).toBe(pluginMarketplace.installationDirectory)
    expect(installationLabel(official)).toBe(pluginMarketplace.installationOfficialRegistry)
  })

  test("uses the opening snapshot only until the authoritative installed list arrives", () => {
    expect(installedPluginFromSnapshot("focus", undefined, directory)).toBe(directory)
    expect(installedPluginFromSnapshot("focus", [], directory)).toBeUndefined()
    expect(installedPluginFromSnapshot("focus", [official, directory], official)).toBe(directory)
  })

  test("status labels distinguish active, approval-disabled, and ordinary disabled plugins", () => {
    expect(installedPluginStatusView(directory, "development")).toEqual({
      label: pluginMarketplace.statusActive,
      isDisabled: false,
      canReviewPermissions: false,
    })
    expect(installedPluginStatusView(official, "installed")).toEqual({
      label: pluginMarketplace.statusActive,
      isDisabled: false,
      canReviewPermissions: false,
    })

    const approvalDisabled = plugin({
      id: "needs-review",
      name: "Needs Review",
      version: "2.0.0",
      installation: { kind: "directory", spec: "file:///review/dist", path: "/review/dist" },
      health: "disabled",
      loaded: false,
      disabledReason: "Plugin permissions require approval.",
      disabledPhase: "approval",
      capabilities: ["filesystem.read"],
      risk: "medium",
      tools: [{ id: "scan", fullId: "needs-review.scan", capabilities: ["filesystem.read"] }],
      operations: [{ id: "sync", type: "command", expose: ["api"] }],
      uiContributions: 1,
    })
    expect(isApprovalDisabledPlugin(approvalDisabled)).toBe(true)
    expect(installedPluginStatusView(approvalDisabled, "development")).toEqual({
      label: pluginMarketplace.statusNeedsApproval,
      isDisabled: true,
      canReviewPermissions: true,
    })
    expect(installedPluginsForView([approvalDisabled], "development", "/review/dist")).toEqual([approvalDisabled])

    const disabled = plugin({
      id: "broken",
      installation: { kind: "directory", spec: "file:///broken/dist", path: "/broken/dist" },
      health: "disabled",
      loaded: false,
      disabledReason: "Entrypoint failed",
      disabledPhase: "runtime",
    })
    expect(isApprovalDisabledPlugin(disabled)).toBe(false)
    expect(installedPluginStatusView(disabled, "development")).toEqual({
      label: pluginMarketplace.statusDisabled,
      isDisabled: true,
      canReviewPermissions: false,
    })
  })
})

describe("plugin content pass-through boundary", () => {
  test("navigation and installation descriptors re-resolve after a locale switch", () => {
    const i18n = setupI18n({ locale: "en" })
    expect(MARKETPLACE_NAV_ITEMS.map((item) => i18n._(item.label))).toEqual(["Discover", "Installed", "Development"])
    expect(
      i18n._(installationLabel(plugin({ id: "a", installation: { kind: "directory", spec: "s", path: "p" } }))),
    ).toBe("Local directory")
    expect(
      i18n._(installationLabel(plugin({ id: "e", installation: { kind: "package", source: "npm", spec: "s" } }))),
    ).toBe("NPM package")

    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: {
        [pluginMarketplace.navDiscover.id]: "发现",
        [pluginMarketplace.installationDirectory.id]: "本地目录",
        [pluginMarketplace.installationPackage.id]: "{source} 包",
      },
    })
    expect(i18n._(MARKETPLACE_NAV_ITEMS[0]!.label)).toBe("发现")
    expect(
      i18n._(installationLabel(plugin({ id: "a", installation: { kind: "directory", spec: "s", path: "p" } }))),
    ).toBe("本地目录")
    expect(
      i18n._(installationLabel(plugin({ id: "e", installation: { kind: "package", source: "npm", spec: "s" } }))),
    ).toBe("NPM 包")
  })

  test("installationLabel never includes plugin id or name in the label", () => {
    const p = plugin({
      id: "my-unique-plugin-xyz",
      name: "Plugin Name",
      installation: { kind: "directory", spec: "s", path: "/tmp/x" },
    })
    const label = installationLabel(p)
    expect(label.values).toBeUndefined()
    expect(label).toBe(pluginMarketplace.installationDirectory)
  })

  test("installationLabel for registry uses canonical labels without naming the plugin", () => {
    const official = plugin({ id: "ghost", installation: { kind: "registry", registry: "official", spec: "s" } })
    const local = plugin({ id: "alias", installation: { kind: "registry", registry: "local", spec: "s" } })
    expect(installationLabel(official)).toBe(pluginMarketplace.installationOfficialRegistry)
    expect(installationLabel(local)).toBe(pluginMarketplace.installationLocalRegistry)
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

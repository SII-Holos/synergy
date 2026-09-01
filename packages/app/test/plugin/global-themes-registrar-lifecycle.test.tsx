import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { PluginContribution } from "../../src/plugin/api"
import type { PluginUIAssets } from "../../src/plugin/ui-assets"
import type { PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"

// The registrar component owns the plugin-theme registry lifecycle. This
// harness exercises that ownership behaviorally: mount registers the fetched
// generation, host/scope signal changes republish, and unmount clears the
// registry. Contexts the component reads are mocked at their boundaries; the
// registry itself is real.
const [dir, setDir] = createSignal("/first")
const [pluginList, setPluginList] = createSignal<PluginContribution[]>([])

mock.module("@solidjs/router", () => ({
  useParams: () => ({
    get dir() {
      return dir()
    },
  }),
}))
mock.module("../../src/context/server", () => ({
  useServer: () => ({ url: "http://registrar.local" }),
}))
mock.module("../../src/plugin/host", () => ({
  usePluginHost: () => ({ plugins: pluginList }),
}))
mock.module("../../src/plugin/api", () => ({
  fetchGlobalThemeContributions: async () => [],
}))
mock.module("../../src/plugin/ui-assets", () => ({
  loadPluginUIAssets: async () => currentAssets,
}))

const { GlobalPluginThemesRegistrar } = await import("../../src/plugin/global-themes")
const theme = await import("@ericsanchezok/synergy-ui/theme")

const SKIN_A: PluginThemeDefinition = {
  id: "plugin-a:skin",
  label: "Skin A",
  theme: { id: "skin", name: "Skin A", light: { seeds: {} }, dark: { seeds: {} } } as never,
  pluginId: "plugin-a",
}
const SKIN_B: PluginThemeDefinition = {
  id: "plugin-b:skin",
  label: "Skin B",
  theme: { id: "skin", name: "Skin B", light: { seeds: {} }, dark: { seeds: {} } } as never,
  pluginId: "plugin-b",
}

function assetsWith(themes: PluginThemeDefinition[]): PluginUIAssets {
  return {
    themes: new Map(themes.map((entry) => [entry.id, entry])),
    icons: new Map(),
    stylesheets: new Map(),
    errors: [],
  }
}

let currentAssets: PluginUIAssets = assetsWith([SKIN_A])

afterEach(() => {
  theme.replacePluginThemes([], { ready: false })
})

describe("GlobalPluginThemesRegistrar ownership lifecycle", () => {
  test("registers the fetched generation on mount and republishes on host changes", async () => {
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      GlobalPluginThemesRegistrar()
    })

    await Bun.sleep(30)
    expect(theme.isPluginThemeRegistryReady()).toBe(true)
    expect(theme.getPluginTheme("plugin-a:skin")?.pluginId).toBe("plugin-a")

    // A plugin-host contribution change (marketplace install) must republish.
    currentAssets = assetsWith([SKIN_A, SKIN_B])
    setPluginList([
      {
        pluginId: "plugin-b",
        name: "plugin-b",
        version: "1",
        generation: "g",
        scopeId: "s",
        capabilities: [],
        contributions: [],
      },
    ])
    await Bun.sleep(30)
    expect(theme.getPluginTheme("plugin-b:skin")?.pluginId).toBe("plugin-b")

    // Unmount drops ownership: the registry resets to not-ready so a replaced
    // server cannot leave stale themes registered.
    dispose()
    await Bun.sleep(10)
    expect(theme.isPluginThemeRegistryReady()).toBe(false)
    expect(theme.getPluginTheme("plugin-a:skin")).toBeUndefined()
    expect(theme.getPluginTheme("plugin-b:skin")).toBeUndefined()
  })

  test("refetches when the active directory route changes", async () => {
    currentAssets = assetsWith([SKIN_A])
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      GlobalPluginThemesRegistrar()
    })
    await Bun.sleep(30)
    expect(theme.getPluginTheme("plugin-a:skin")).toBeDefined()

    currentAssets = assetsWith([SKIN_B])
    setDir("/second")
    await Bun.sleep(30)
    expect(theme.getPluginTheme("plugin-a:skin")).toBeUndefined()
    expect(theme.getPluginTheme("plugin-b:skin")).toBeDefined()

    dispose()
  })
})

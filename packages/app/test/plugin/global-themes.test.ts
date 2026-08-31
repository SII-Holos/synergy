import { describe, expect, test } from "bun:test"
import { createGlobalThemeRegistrar, type GlobalThemeRegistrarDeps } from "../../src/plugin/global-theme-registrar"
import type { PluginContribution } from "../../src/plugin/api"
import type { PluginUIAssetError, PluginUIAssets } from "../../src/plugin/ui-assets"
import type { PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"

const THEME_A: PluginThemeDefinition = {
  id: "plugin-a:skin",
  label: "Skin A",
  theme: { id: "skin", name: " Skin A", light: { seeds: {} }, dark: { seeds: {} } } as never,
  pluginId: "plugin-a",
}

const THEME_B: PluginThemeDefinition = {
  id: "plugin-b:skin",
  label: "Skin B",
  theme: { id: "skin", name: "Skin B", light: { seeds: {} }, dark: { seeds: {} } } as never,
  pluginId: "plugin-b",
}

function assets(themes: PluginThemeDefinition[] = [], errors: PluginUIAssetError[] = []): PluginUIAssets {
  return {
    themes: new Map(themes.map((theme) => [theme.id, theme])),
    icons: new Map(),
    stylesheets: new Map(),
    errors,
  }
}

interface Harness {
  deps: GlobalThemeRegistrarDeps
  published: Array<Array<PluginThemeDefinition>>
  cleared: () => number
  fetchCalls: () => number
}

function createHarness(
  options: {
    fetchResult?: () => Promise<PluginContribution[]>
    loadResult?: () => PluginUIAssets
  } = {},
): Harness {
  let fetchCalls = 0
  let cleared = 0
  const published: Array<Array<PluginThemeDefinition>> = []
  const deps: GlobalThemeRegistrarDeps = {
    serverUrl: () => "http://server.local",
    fetchContributions: () => {
      fetchCalls++
      return options.fetchResult ? options.fetchResult() : Promise.resolve([])
    },
    loadAssets: async () => options.loadResult?.() ?? assets(),
    replaceThemes: (themes) => published.push([...themes]),
    clearThemes: () => {
      cleared++
    },
    retryDelayMs: 10,
  }
  return { deps, published, cleared: () => cleared, fetchCalls: () => fetchCalls }
}

describe("createGlobalThemeRegistrar", () => {
  test("publishes the fetched theme generation atomically", async () => {
    const harness = createHarness({ loadResult: () => assets([THEME_A]) })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()

    expect(harness.fetchCalls()).toBe(1)
    expect(harness.published).toHaveLength(1)
    expect(harness.published[0].map((theme) => theme.id)).toEqual(["plugin-a:skin"])
  })

  test("discards a stale refresh result when a newer refresh takes over", async () => {
    const resolvers: Array<() => void> = []
    const harness = createHarness({
      fetchResult: () => new Promise((resolve) => resolvers.push(() => resolve([]))),
      loadResult: () => assets([THEME_A]),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    const first = registrar.refresh()
    const second = registrar.refresh()
    for (const release of resolvers) release()
    await Promise.all([first, second])

    expect(harness.fetchCalls()).toBe(2)
    expect(harness.published).toHaveLength(1)
  })

  test("keeps the last published generation when theme assets report load errors", async () => {
    let failing = false
    const harness = createHarness({
      loadResult: () => (failing ? assets([], [{ pluginId: "plugin-a", message: "HTTP 500" }]) : assets([THEME_A])),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()
    expect(harness.published).toHaveLength(1)

    // A transient asset failure must not publish a partial generation that
    // unregisters the healthy themes; the failed generation retries once
    // (direct call + scheduled retry) and the last generation is kept.
    failing = true
    await registrar.refresh()
    expect(harness.published).toHaveLength(1)

    await Bun.sleep(30)
    expect(harness.fetchCalls()).toBe(3)
    expect(harness.published).toHaveLength(1)
    expect(harness.published[0].map((theme) => theme.id)).toEqual(["plugin-a:skin"])

    await Bun.sleep(40)
    expect(harness.fetchCalls()).toBe(3)
  })

  test("recovers with a published generation after a successful retry", async () => {
    let failures = 0
    const harness = createHarness({
      fetchResult: () => {
        failures++
        return failures === 1 ? Promise.reject(new Error("transient")) : Promise.resolve([])
      },
      loadResult: () => assets([THEME_B]),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()
    await Bun.sleep(30)

    expect(harness.fetchCalls()).toBe(2)
    expect(harness.published).toHaveLength(1)
    expect(harness.published[0].map((theme) => theme.id)).toEqual(["plugin-b:skin"])
  })

  test("retries a failed fetch once and stops after the second failure", async () => {
    let failures = 0
    const harness = createHarness({
      fetchResult: () => {
        failures++
        return failures <= 2 ? Promise.reject(new Error("network down")) : Promise.resolve([])
      },
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()
    await Bun.sleep(30)
    expect(harness.fetchCalls()).toBe(2)

    await Bun.sleep(40)
    expect(harness.fetchCalls()).toBe(2)
  })

  test("skips fetching entirely without a server url", async () => {
    const harness = createHarness()
    harness.deps.serverUrl = () => undefined
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()

    expect(harness.fetchCalls()).toBe(0)
    expect(harness.published).toHaveLength(0)
  })

  test("canceling via dispose drops an in-flight refresh and clears the registry", async () => {
    let release: (() => void) | undefined
    const harness = createHarness({
      fetchResult: () => new Promise((resolve) => (release = () => resolve([]))),
      loadResult: () => assets([THEME_A]),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    const pending = registrar.refresh()
    registrar.dispose()
    release?.()
    await pending

    expect(harness.published).toHaveLength(0)
    expect(harness.cleared()).toBe(1)
  })
})

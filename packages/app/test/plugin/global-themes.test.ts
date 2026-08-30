import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createGlobalThemeRegistrar, type GlobalThemeRegistrarDeps } from "../../src/plugin/global-theme-registrar"
import type { PluginContribution } from "../../src/plugin/api"
import type { PluginUIAssets } from "../../src/plugin/ui-assets"
import type { PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"

const THEME_A: PluginThemeDefinition = {
  id: "plugin-a:skin",
  label: "Skin A",
  theme: { id: "skin", name: "Skin A", light: { seeds: {} }, dark: { seeds: {} } } as never,
  pluginId: "plugin-a",
}

function emptyAssets(): PluginUIAssets {
  return { themes: new Map(), icons: new Map(), stylesheets: new Map(), errors: [] }
}

function themeAssets(): PluginUIAssets {
  return { ...emptyAssets(), themes: new Map([[THEME_A.id, THEME_A]]) }
}

interface Harness {
  deps: GlobalThemeRegistrarDeps
  published: Array<Array<PluginThemeDefinition>>
  fetchCalls: () => number
}

function createHarness(
  options: { fetchResult?: () => Promise<PluginContribution[]>; assets?: PluginUIAssets } = {},
): Harness {
  let fetchCalls = 0
  const published: Array<Array<PluginThemeDefinition>> = []
  const deps: GlobalThemeRegistrarDeps = {
    serverUrl: () => "http://server.local",
    fetchContributions: () => {
      fetchCalls++
      return options.fetchResult ? options.fetchResult() : Promise.resolve([])
    },
    loadAssets: async () => options.assets ?? emptyAssets(),
    replaceThemes: (themes) => published.push([...themes]),
    retryDelayMs: 10,
  }
  return { deps, published, fetchCalls: () => fetchCalls }
}

describe("createGlobalThemeRegistrar", () => {
  test("publishes the fetched theme generation atomically", async () => {
    const harness = createHarness({ assets: themeAssets() })
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
      assets: themeAssets(),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    const first = registrar.refresh()
    const second = registrar.refresh()
    for (const release of resolvers) release()
    await Promise.all([first, second])

    expect(harness.fetchCalls()).toBe(2)
    expect(harness.published).toHaveLength(1)
  })

  test("retries a failed fetch once and keeps the last published generation on second failure", async () => {
    let failures = 0
    const harness = createHarness({
      fetchResult: () => {
        failures++
        return failures <= 2 ? Promise.reject(new Error("network down")) : Promise.resolve([])
      },
      assets: themeAssets(),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()
    expect(harness.published).toHaveLength(0)

    await Bun.sleep(30)
    expect(harness.fetchCalls()).toBe(2)
    expect(harness.published).toHaveLength(0)

    await Bun.sleep(40)
    expect(harness.fetchCalls()).toBe(2)
  })

  test("recovers with a published generation after a successful retry", async () => {
    let failures = 0
    const harness = createHarness({
      fetchResult: () => {
        failures++
        return failures === 1 ? Promise.reject(new Error("transient")) : Promise.resolve([])
      },
      assets: themeAssets(),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()
    await Bun.sleep(30)

    expect(harness.fetchCalls()).toBe(2)
    expect(harness.published).toHaveLength(1)
    expect(harness.published[0].map((theme) => theme.id)).toEqual(["plugin-a:skin"])
  })

  test("skips fetching entirely without a server url", async () => {
    const harness = createHarness()
    harness.deps.serverUrl = () => undefined
    const registrar = createGlobalThemeRegistrar(harness.deps)

    await registrar.refresh()

    expect(harness.fetchCalls()).toBe(0)
    expect(harness.published).toHaveLength(0)
  })

  test("canceling via dispose drops an in-flight refresh", async () => {
    let release: (() => void) | undefined
    const harness = createHarness({
      fetchResult: () => new Promise((resolve) => (release = () => resolve([]))),
      assets: themeAssets(),
    })
    const registrar = createGlobalThemeRegistrar(harness.deps)

    const pending = registrar.refresh()
    registrar.dispose()
    release?.()
    await pending

    expect(harness.published).toHaveLength(0)
  })
})

test("the global registrar is the only app-side caller of replacePluginThemes", () => {
  const appRoot = path.resolve(import.meta.dir, "../../src")
  const offenders: string[] = []
  for (const file of walkCollecting(appRoot, /\.tsx?$/, [])) {
    if (file.endsWith("global-themes.tsx")) continue
    const source = readFileSync(file, "utf8")
    if (source.includes("replacePluginThemes")) offenders.push(path.relative(appRoot, file))
  }
  expect(offenders).toEqual([])
})

function walkCollecting(dir: string, pattern: RegExp, acc: string[]): string[] {
  const entries = [...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })]
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (pattern.test(full)) acc.push(full)
  }
  return acc
}

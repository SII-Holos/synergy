import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { JSDOM } from "jsdom"

// The real context helper renders JSX; bun's test transform compiles JSX with
// the React runtime. Substitute a plain provider so the ThemeProvider init
// logic (the non-destructive fallback under test) can run directly.
let currentApi: unknown
let disposers: Array<() => void> = []
mock.module("../src/context/helper", () => ({
  createSimpleContext: (input: { name: string; init: () => unknown }) => ({
    provider: (props: { children?: unknown }) => {
      currentApi = createRoot((dispose) => {
        disposers.push(dispose)
        return input.init()
      })
      return props.children
    },
    use: () => currentApi,
  }),
}))

const { ThemeProvider, useTheme } = await import("../src/theme/context")
const { replacePluginThemes } = await import("../src/theme/plugin-theme-registry")
const { synergyTheme } = await import("../src/theme/default-themes")
const { SKIN_BOOTSTRAP_STORAGE_KEY, createSkinBootstrapSnapshot } = await import("../src/theme/shell-skin")

type ThemeApi = ReturnType<typeof useTheme>
let dom: JSDOM | undefined

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><head><meta name="theme-color"></head><body></body></html>', {
    url: "http://localhost/",
  })
  const globals = globalThis as unknown as Record<string, unknown>
  globals.document = dom.window.document
  globals.window = dom.window
  globals.localStorage = dom.window.localStorage
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as never
  replacePluginThemes([], { ready: false })
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  const globals = globalThis as unknown as Record<string, unknown>
  delete globals.document
  delete globals.window
  delete globals.localStorage
  dom?.window.close()
  dom = undefined
  replacePluginThemes([], { ready: false })
})

const PLUGIN_THEME_ID = "scope-a:skin"
const PLUGIN_THEME = { ...synergyTheme, id: "skin", name: "Fixture Skin" }

function mountProvider(): ThemeApi {
  ThemeProvider({ children: null })
  return currentApi as ThemeApi
}

function seedPluginThemeSelection() {
  dom!.window.localStorage.setItem(
    SKIN_BOOTSTRAP_STORAGE_KEY,
    JSON.stringify(createSkinBootstrapSnapshot(PLUGIN_THEME_ID, PLUGIN_THEME)),
  )
}

function storedSnapshot(): { themeId: string; themeName: string } {
  const raw = dom!.window.localStorage.getItem(SKIN_BOOTSTRAP_STORAGE_KEY)
  if (!raw) throw new Error("skin cache missing")
  const parsed = JSON.parse(raw) as { themeId: string; theme: { name: string } }
  return { themeId: parsed.themeId, themeName: parsed.theme.name }
}

describe("ThemeProvider non-destructive fallback", () => {
  test("keeps the selected plugin theme id and skin cache when the ready registry loses it", async () => {
    seedPluginThemeSelection()
    const theme = mountProvider()
    await Bun.sleep(20)

    // The registry settles without the plugin theme (scope switch, asset failure).
    replacePluginThemes([], { ready: true })
    await Bun.sleep(20)

    expect(theme.degraded()).toBe(true)
    expect(theme.themeId()).toBe(PLUGIN_THEME_ID)
    expect(dom!.window.document.documentElement.dataset.theme).toBe(PLUGIN_THEME_ID)
    // Degraded rendering falls back to default tokens without persisting them.
    expect(theme.theme()).toBe(synergyTheme)
    expect(storedSnapshot()).toEqual({ themeId: PLUGIN_THEME_ID, themeName: "Fixture Skin" })

    // The registry refills the theme: the retained selection re-applies automatically.
    replacePluginThemes([{ id: PLUGIN_THEME_ID, label: "Fixture Skin", theme: PLUGIN_THEME, pluginId: "scope-a" }])
    await Bun.sleep(20)

    expect(theme.degraded()).toBe(false)
    expect(theme.theme()).toBe(PLUGIN_THEME)
    expect(theme.themeId()).toBe(PLUGIN_THEME_ID)
    expect(storedSnapshot().themeId).toBe(PLUGIN_THEME_ID)
  })

  test("leaves the default-skin path untouched when no plugin theme was selected", async () => {
    const theme = mountProvider()
    await Bun.sleep(20)

    expect(theme.themeId()).toBe(synergyTheme.id)
    replacePluginThemes([], { ready: true })
    await Bun.sleep(20)

    expect(theme.themeId()).toBe(synergyTheme.id)
    expect(theme.theme()).toBe(synergyTheme)
    expect(storedSnapshot().themeId).toBe(synergyTheme.id)
  })
})

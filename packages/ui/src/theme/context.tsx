import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { synergyTheme } from "./default-themes"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { createSimpleContext } from "../context/helper"
import { getPluginTheme, listThemeChoices, subscribePluginThemes } from "./plugin-theme-registry"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  COLOR_SCHEME: "synergy-color-scheme",
} as const

const THEME_STYLE_ID = "synergy-theme"
const PLUGIN_THEME_LINK_ID = "synergy-plugin-theme"

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function ensurePluginThemeLinkElement(): HTMLLinkElement {
  const existing = document.getElementById(PLUGIN_THEME_LINK_ID) as HTMLLinkElement | null
  if (existing) return existing
  const element = document.createElement("link")
  element.id = PLUGIN_THEME_LINK_ID
  element.rel = "stylesheet"
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function isColorScheme(value: string | null): value is ColorScheme {
  return value === "light" || value === "dark" || value === "system"
}

function getSavedColorScheme(): ColorScheme | null {
  try {
    if (typeof localStorage === "undefined") return null
    const value = localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)
    return isColorScheme(value) ? value : null
  } catch {
    return null
  }
}

function resolveColorSchemeMode(scheme: ColorScheme): "light" | "dark" {
  return scheme === "system" ? getSystemMode() : scheme
}

function applyThemeCss(mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? synergyTheme.dark : synergyTheme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.colorScheme = mode
}

function applyPluginThemeCss(themeId: string) {
  const pluginTheme = getPluginTheme(themeId)
  const existing = document.getElementById(PLUGIN_THEME_LINK_ID) as HTMLLinkElement | null
  if (!pluginTheme?.cssUrl) {
    existing?.remove()
    document.documentElement.dataset.theme = synergyTheme.id
    return
  }

  const link = ensurePluginThemeLinkElement()
  link.href = pluginTheme.cssUrl
  document.documentElement.dataset.theme = pluginTheme.id
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: () => {
    const initialColorScheme = getSavedColorScheme() ?? "system"
    const [store, setStore] = createStore({
      colorScheme: initialColorScheme,
      mode: resolveColorSchemeMode(initialColorScheme),
      themeId: synergyTheme.id,
    })
    const [themeRegistryVersion, setThemeRegistryVersion] = createSignal(0)

    onMount(() => {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const handler = () => {
        if (store.colorScheme === "system") {
          setStore("mode", getSystemMode())
        }
      }
      mediaQuery.addEventListener("change", handler)
      onCleanup(() => mediaQuery.removeEventListener("change", handler))

      const savedScheme = getSavedColorScheme()
      if (savedScheme) {
        setStore("colorScheme", savedScheme)
        setStore("mode", resolveColorSchemeMode(savedScheme))
      }

      const unsubscribe = subscribePluginThemes(() => setThemeRegistryVersion((version) => version + 1))
      onCleanup(unsubscribe)
    })

    createEffect(() => {
      applyThemeCss(store.mode)
    })

    createEffect(() => {
      themeRegistryVersion()
      const activeId = store.themeId || synergyTheme.id
      if (activeId !== synergyTheme.id && !getPluginTheme(activeId)) {
        setStore("themeId", synergyTheme.id)
        return
      }
      applyPluginThemeCss(activeId)
    })

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    const setThemeId = (id: string) => {
      const next = !id || id === synergyTheme.id ? synergyTheme.id : id
      if (next !== synergyTheme.id && !getPluginTheme(next)) return
      setStore("themeId", next)
    }

    return {
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      theme: () => synergyTheme,
      themeId: () => store.themeId,
      themes: () => {
        themeRegistryVersion()
        return listThemeChoices()
      },
      setColorScheme,
      setThemeId,
    }
  },
})

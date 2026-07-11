import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { synergyTheme } from "./default-themes"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { createSimpleContext } from "../context/helper"
import { getPluginTheme, listThemeChoices, subscribePluginThemes } from "./plugin-theme-registry"
import type { Theme } from "./types"
import {
  COLOR_SCHEME_STORAGE_KEY,
  getSavedColorScheme,
  getSystemMode,
  resolveColorSchemeMode,
  type ColorScheme,
} from "./color-scheme"

const THEME_STYLE_ID = "synergy-theme"

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function applyBootShellColorScheme(mode: "light" | "dark") {
  document.documentElement.dataset.synergyColorScheme = mode
}

function applyThemeCss(theme: Theme, mode: "light" | "dark", themeId = theme.id) {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.dataset.theme = themeId
  applyBootShellColorScheme(mode)
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
    applyThemeCss(synergyTheme, resolveColorSchemeMode(initialColorScheme))
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

      const unsubscribe = subscribePluginThemes(() => setThemeRegistryVersion((version) => version + 1))
      onCleanup(unsubscribe)
    })

    createEffect(() => {
      themeRegistryVersion()
      const activeId = store.themeId || synergyTheme.id
      const pluginTheme = activeId === synergyTheme.id ? undefined : getPluginTheme(activeId)
      if (activeId !== synergyTheme.id && !pluginTheme) {
        setStore("themeId", synergyTheme.id)
        return
      }
      applyThemeCss(pluginTheme?.theme ?? synergyTheme, store.mode, activeId)
    })

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme)
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
      theme: () => getPluginTheme(store.themeId)?.theme ?? synergyTheme,
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

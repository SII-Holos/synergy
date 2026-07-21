import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { applyThemeToDocument } from "./application"
import { synergyTheme } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { Theme } from "./types"
import { createSimpleContext } from "../context/helper"
import {
  getPluginTheme,
  isPluginThemeRegistryReady,
  listThemeChoices,
  subscribePluginThemes,
} from "./plugin-theme-registry"
import { createSkinBootstrapSnapshot, readSkinBootstrapSnapshot, writeSkinBootstrapSnapshot } from "./shell-skin"
import {
  COLOR_SCHEME_STORAGE_KEY,
  getSavedColorScheme,
  getSystemMode,
  resolveColorSchemeMode,
  type ColorScheme,
} from "./color-scheme"

function resolveThemeForMode(theme: Theme, mode: "light" | "dark") {
  const isDark = mode === "dark"
  return resolveThemeVariant(isDark ? theme.dark : theme.light, isDark)
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: () => {
    const initialColorScheme = getSavedColorScheme() ?? "system"
    const initialMode = resolveColorSchemeMode(initialColorScheme)
    const bootstrap = readSkinBootstrapSnapshot()
    const [store, setStore] = createStore({
      colorScheme: initialColorScheme,
      mode: initialMode,
      themeId: bootstrap?.themeId ?? synergyTheme.id,
    })
    const initialTheme = bootstrap?.theme ?? synergyTheme
    applyThemeToDocument(document, resolveThemeForMode(initialTheme, initialMode), initialMode, store.themeId)
    const [themeRegistryVersion, setThemeRegistryVersion] = createSignal(0)
    const activeTheme = createMemo(() => {
      themeRegistryVersion()
      const registered = getPluginTheme(store.themeId)?.theme
      if (registered) return registered
      if (!isPluginThemeRegistryReady() && bootstrap?.themeId === store.themeId) return bootstrap.theme
      return synergyTheme
    })
    const tokens = createMemo(() => {
      return resolveThemeForMode(activeTheme(), store.mode)
    })

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
      const activeId = store.themeId || synergyTheme.id
      const pluginTheme = activeId === synergyTheme.id ? undefined : getPluginTheme(activeId)
      if (activeId !== synergyTheme.id && !pluginTheme && isPluginThemeRegistryReady()) {
        setStore("themeId", synergyTheme.id)
        return
      }
      const theme = activeTheme()
      applyThemeToDocument(document, tokens(), store.mode, activeId)
      writeSkinBootstrapSnapshot(createSkinBootstrapSnapshot(activeId, theme))
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
      theme: activeTheme,
      tokens,
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

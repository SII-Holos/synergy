import { onMount, onCleanup, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { synergyTheme } from "./default-themes"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { createSimpleContext } from "../context/helper"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  COLOR_SCHEME: "synergy-color-scheme",
} as const

const THEME_STYLE_ID = "oc-theme"

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
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

  document.getElementById("oc-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.colorScheme = mode
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: () => {
    const [store, setStore] = createStore({
      colorScheme: "system" as ColorScheme,
      mode: getSystemMode(),
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

      const savedScheme = localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null
      if (savedScheme) {
        setStore("colorScheme", savedScheme)
        if (savedScheme !== "system") {
          setStore("mode", savedScheme)
        }
      }
    })

    createEffect(() => {
      applyThemeCss(store.mode)
    })

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    return {
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      theme: () => synergyTheme,
      setColorScheme,
    }
  },
})

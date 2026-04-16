import type { ResolvedTheme } from "./types"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { synergyTheme } from "./default-themes"

const THEME_STYLE_ID = "synergy-theme"

function ensureLoaderStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) {
    return existing
  }
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

export function applyTheme(mode: "light" | "dark"): void {
  const isDark = mode === "dark"
  const variant = isDark ? synergyTheme.dark : synergyTheme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = buildThemeCss(tokens, mode)
  const themeStyleElement = ensureLoaderStyleElement()
  themeStyleElement.textContent = css
}

function buildThemeCss(tokens: ResolvedTheme, mode: "light" | "dark"): string {
  const css = themeToCss(tokens)
  return `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${mode === "dark" ? "plus-lighter" : "multiply"};
  ${css}
}`
}

export function setColorScheme(scheme: "light" | "dark" | "auto"): void {
  if (scheme === "auto") {
    document.documentElement.style.removeProperty("color-scheme")
  } else {
    document.documentElement.style.setProperty("color-scheme", scheme)
  }
}

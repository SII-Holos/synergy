import { themeToCss } from "./resolve"
import type { ResolvedTheme } from "./types"

export const THEME_CHANGE_EVENT = "synergy:theme-change"

export interface ThemeChangeDetail {
  mode: "light" | "dark"
  themeId: string
  tokens: ResolvedTheme
}

const THEME_STYLE_ID = "synergy-theme"
const appliedThemes = new WeakMap<Document, ThemeChangeDetail>()

export function getAppliedTheme(targetDocument: Document): ThemeChangeDetail | undefined {
  return appliedThemes.get(targetDocument)
}

function ensureThemeStyleElement(targetDocument: Document): HTMLStyleElement {
  const existing = targetDocument.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = targetDocument.createElement("style")
  element.id = THEME_STYLE_ID
  targetDocument.head.appendChild(element)
  return element
}

export function applyThemeToDocument(
  targetDocument: Document,
  tokens: ResolvedTheme,
  mode: "light" | "dark",
  themeId: string,
) {
  ensureThemeStyleElement(targetDocument).textContent = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${mode === "dark" ? "plus-lighter" : "multiply"};
  ${themeToCss(tokens)}
}`
  targetDocument.documentElement.dataset.colorScheme = mode
  targetDocument.documentElement.dataset.synergyColorScheme = mode
  targetDocument.documentElement.dataset.theme = themeId
  const themeColor = targetDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  themeColor?.setAttribute("content", tokens["background-stronger"])
  const CustomEventConstructor = targetDocument.defaultView?.CustomEvent ?? CustomEvent
  const detail: ThemeChangeDetail = { mode, themeId, tokens }
  appliedThemes.set(targetDocument, detail)
  targetDocument.dispatchEvent(new CustomEventConstructor(THEME_CHANGE_EVENT, { detail }))
}

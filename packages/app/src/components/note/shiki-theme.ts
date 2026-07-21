import { bundledThemes, type BundledTheme, type ThemeRegistrationRaw } from "shiki"
import { synergyHighlightTheme } from "@ericsanchezok/synergy-ui/context/marked"

export const SYNERGY_SHIKI_LIGHT = "synergy-light" as BundledTheme
export const SYNERGY_SHIKI_DARK = "synergy-dark" as BundledTheme

export function registerSynergyShikiThemes() {
  const themes = bundledThemes as Record<string, () => Promise<{ default: ThemeRegistrationRaw }>>
  themes[SYNERGY_SHIKI_LIGHT] = async () => ({
    default: { ...synergyHighlightTheme, name: SYNERGY_SHIKI_LIGHT, type: "light" } as ThemeRegistrationRaw,
  })
  themes[SYNERGY_SHIKI_DARK] = async () => ({
    default: { ...synergyHighlightTheme, name: SYNERGY_SHIKI_DARK, type: "dark" } as ThemeRegistrationRaw,
  })
}

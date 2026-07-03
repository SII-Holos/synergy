export type ColorScheme = "light" | "dark" | "system"

export const COLOR_SCHEME_STORAGE_KEY = "synergy-color-scheme"

type ColorSchemeStorage = Pick<Storage, "getItem">

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark" || value === "system"
}

export function getSavedColorScheme(
  storage: ColorSchemeStorage | undefined = globalThis.localStorage,
): ColorScheme | null {
  try {
    const value = storage?.getItem(COLOR_SCHEME_STORAGE_KEY)
    return isColorScheme(value) ? value : null
  } catch {
    return null
  }
}

export function getSystemMode(matchMedia = globalThis.matchMedia): "light" | "dark" {
  if (!matchMedia) return "light"
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function resolveColorSchemeMode(scheme: ColorScheme): "light" | "dark" {
  return scheme === "system" ? getSystemMode() : scheme
}

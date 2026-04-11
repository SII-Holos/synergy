export type {
  Theme,
  ThemeSeedColors,
  ThemeVariant,
  HexColor,
  OklchColor,
  ResolvedTheme,
  ColorValue,
  CssVarRef,
} from "./types"

export {
  hexToRgb,
  rgbToHex,
  hexToOklch,
  oklchToHex,
  rgbToOklch,
  oklchToRgb,
  generateScale,
  generateNeutralScale,
  generateAlphaScale,
  mixColors,
  lighten,
  darken,
  withAlpha,
} from "./color"

export { resolveThemeVariant, resolveTheme, themeToCss } from "./resolve"
export { applyTheme, setColorScheme } from "./loader"
export { ThemeProvider, useTheme, type ColorScheme } from "./context"

export { synergyTheme, oc1Theme } from "./default-themes"

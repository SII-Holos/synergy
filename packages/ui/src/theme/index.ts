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
  mixColors,
  lighten,
  darken,
  withAlpha,
} from "./color"

export { resolveThemeVariant, resolveTheme, themeToCss } from "./resolve"
export { ThemeProvider, useTheme } from "./context"
export type { ColorScheme } from "./color-scheme"
export {
  registerPluginTheme,
  listPluginThemes,
  getPluginTheme,
  listThemeChoices,
  subscribePluginThemes,
  type PluginThemeDefinition,
} from "./plugin-theme-registry"

export { synergyTheme } from "./default-themes"

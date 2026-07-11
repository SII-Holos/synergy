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

export { resolveThemeVariant, resolveTheme, resolveThemeColor, themeToCss } from "./resolve"
export { applyThemeToDocument, THEME_CHANGE_EVENT } from "./application"
export type { ThemeChangeDetail } from "./application"
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
export { ThemeSchema, parseTheme } from "./schema"
export { THEME_TOKEN_NAMES, THEME_TOKEN_SET, type ThemeTokenName } from "./tokens"

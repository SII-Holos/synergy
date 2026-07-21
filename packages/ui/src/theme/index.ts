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
export { applyThemeToDocument, getAppliedTheme, THEME_CHANGE_EVENT } from "./application"
export type { ThemeChangeDetail } from "./application"
export { ThemeProvider, useTheme } from "./context"
export type { ColorScheme } from "./color-scheme"
export {
  registerPluginTheme,
  replacePluginThemes,
  isPluginThemeRegistryReady,
  listPluginThemes,
  getPluginTheme,
  listThemeChoices,
  subscribePluginThemes,
  type PluginThemeDefinition,
} from "./plugin-theme-registry"

export { synergyTheme } from "./default-themes"
export { ThemeSchema, parseTheme } from "./schema"
export { THEME_TOKEN_NAMES, THEME_TOKEN_SET, type ThemeTokenName } from "./tokens"
export {
  SKIN_BOOTSTRAP_STORAGE_KEY,
  ShellSkinColorsSchema,
  ShellSkinSnapshotSchema,
  SkinBootstrapSnapshotSchema,
  deriveShellSkin,
  createSkinBootstrapSnapshot,
  readSkinBootstrapSnapshot,
  writeSkinBootstrapSnapshot,
  type ShellSkinColors,
  type ShellSkinSnapshot,
  type SkinBootstrapSnapshot,
} from "./shell-skin"

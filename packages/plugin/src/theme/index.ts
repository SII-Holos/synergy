export type {
  Theme,
  ThemeSeedColors,
  ThemeVariant,
  HexColor,
  OklchColor,
  ResolvedTheme,
  ColorValue,
  CssVarRef,
} from "./types.js"

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
} from "./color.js"

export {
  resolveThemeVariant,
  resolveTheme,
  resolveThemeColor,
  themeToCss,
  THEME_CONTRAST_REQUIREMENTS,
  type ThemeContrastRequirement,
} from "./resolve.js"
export { ThemeSchema, parseTheme } from "./schema.js"
export { renderThemeSchemaJson } from "./schema-json.js"
export { THEME_TOKEN_NAMES, THEME_TOKEN_SET, type ThemeTokenName } from "./tokens.js"
export {
  CSS_VAR_REF_PATTERN,
  HEX_COLOR_PATTERN,
  HEX_COLOR_REGEX,
  OPAQUE_HEX_COLOR_PATTERN,
  THEME_ALL_SEED_NAMES,
  THEME_CORE_SEED_NAMES,
  THEME_ID_PATTERN,
  THEME_SEED_NAMES,
  THEME_SYNTAX_SEED_NAMES,
  normalizeSeedColors,
  type ThemeAllSeedName,
  type ThemeCoreSeedName,
  type ThemeSeedName,
  type ThemeSeedInput,
  type ThemeSyntaxSeedName,
} from "./schema-contract.js"

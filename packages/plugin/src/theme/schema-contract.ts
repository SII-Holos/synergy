export const THEME_CORE_SEED_NAMES = [
  "neutral",
  "primary",
  "success",
  "warning",
  "error",
  "info",
  "interactive",
  "diffAdd",
  "diffDelete",
] as const

/**
 * Syntax colors intentionally remain independent of interaction/status colors.
 * They are optional in serialized themes for compatibility with the original
 * nine-seed plugin format, but are always present after parsing.
 */
export const THEME_SYNTAX_SEED_NAMES = ["syntaxString", "syntaxKeyword", "syntaxType", "syntaxProperty"] as const

export const THEME_SEED_NAMES = [...THEME_CORE_SEED_NAMES, ...THEME_SYNTAX_SEED_NAMES] as const

export type ThemeSeedName = (typeof THEME_SEED_NAMES)[number]

export const HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
export const OPAQUE_HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"
export const CSS_VAR_REF_PATTERN = "^var\\(--[a-z0-9-]+\\)$"
export const THEME_ID_PATTERN = "^[a-z0-9-]+$"

export const HEX_COLOR_REGEX = new RegExp(HEX_COLOR_PATTERN)

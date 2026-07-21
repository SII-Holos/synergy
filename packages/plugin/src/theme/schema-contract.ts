export const THEME_SEED_NAMES = [
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

export type ThemeSeedName = (typeof THEME_SEED_NAMES)[number]

export const HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
export const OPAQUE_HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"
export const CSS_VAR_REF_PATTERN = "^var\\(--[a-z0-9-]+\\)$"
export const THEME_ID_PATTERN = "^[a-z0-9-]+$"

export const HEX_COLOR_REGEX = new RegExp(HEX_COLOR_PATTERN)

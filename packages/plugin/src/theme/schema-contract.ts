import type { HexColor } from "./types.js"

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

export type ThemeCoreSeedName = (typeof THEME_CORE_SEED_NAMES)[number]
export type ThemeSyntaxSeedName = (typeof THEME_SYNTAX_SEED_NAMES)[number]

/** The original nine-seed public contract (backward-compatible input shape). */
export const THEME_SEED_NAMES = THEME_CORE_SEED_NAMES

/** The full thirteen-seed set: nine core seeds plus four optional syntax seeds. */
export const THEME_ALL_SEED_NAMES = [...THEME_CORE_SEED_NAMES, ...THEME_SYNTAX_SEED_NAMES] as const

/** The original nine-name public union, kept backward compatible for API4 consumers. */
export type ThemeSeedName = (typeof THEME_CORE_SEED_NAMES)[number]

/** The expanded thirteen-name union (core + syntax seeds). */
export type ThemeAllSeedName = (typeof THEME_ALL_SEED_NAMES)[number]

/**
 * Author-facing seed input. The nine core seeds are required; the four syntax
 * seeds are optional and fall back to their semantic counterparts.
 */
export type ThemeSeedInput = Record<ThemeCoreSeedName, HexColor> & Partial<Record<ThemeSyntaxSeedName, HexColor>>

/** The complete, normalized seed set that resolver and consumers operate on. */
export type ThemeSeedColors = Record<ThemeAllSeedName, HexColor>

export const HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
export const OPAQUE_HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"
export const CSS_VAR_REF_PATTERN = "^var\\(--[a-z0-9-]+\\)$"
export const THEME_ID_PATTERN = "^[a-z0-9-]+$"

export const HEX_COLOR_REGEX = new RegExp(HEX_COLOR_PATTERN)

/**
 * Normalize a serialized seed set into the full thirteen-seed contract.
 * The four syntax seeds are optional in author input (nine-seed compatibility);
 * each missing syntax seed falls back to its semantic counterpart
 * (syntaxString ← success, syntaxKeyword ← primary, syntaxType ← info,
 * syntaxProperty ← interactive).
 */
export function normalizeSeedColors(seeds: ThemeSeedInput): ThemeSeedColors {
  return {
    neutral: seeds.neutral,
    primary: seeds.primary,
    success: seeds.success,
    warning: seeds.warning,
    error: seeds.error,
    info: seeds.info,
    interactive: seeds.interactive,
    diffAdd: seeds.diffAdd,
    diffDelete: seeds.diffDelete,
    syntaxString: (seeds.syntaxString ?? seeds.success) as HexColor,
    syntaxKeyword: (seeds.syntaxKeyword ?? seeds.primary) as HexColor,
    syntaxType: (seeds.syntaxType ?? seeds.info) as HexColor,
    syntaxProperty: (seeds.syntaxProperty ?? seeds.interactive) as HexColor,
  }
}

import z from "zod"
import {
  CSS_VAR_REF_PATTERN,
  HEX_COLOR_PATTERN,
  OPAQUE_HEX_COLOR_PATTERN,
  THEME_CORE_SEED_NAMES,
  THEME_ID_PATTERN,
  THEME_SYNTAX_SEED_NAMES,
  normalizeSeedColors,
  type ThemeAllSeedName,
} from "./schema-contract.js"
import { THEME_TOKEN_NAMES, THEME_TOKEN_SET } from "./tokens.js"
import type { HexColor, Theme, ThemeVariant } from "./types.js"
import type { ThemeSeedInput } from "./schema-contract.js"
import { resolveTheme } from "./resolve.js"

const HexColorSchema = z.string().regex(new RegExp(HEX_COLOR_PATTERN))
const OpaqueHexColorSchema = z.string().regex(new RegExp(OPAQUE_HEX_COLOR_PATTERN))
const CssVarRefSchema = z
  .string()
  .regex(new RegExp(CSS_VAR_REF_PATTERN))
  .refine((value) => THEME_TOKEN_SET.has(value.slice(6, -1)), "CSS variable must reference a canonical theme token")
const ColorValueSchema = z.union([HexColorSchema, CssVarRefSchema])
const ThemeTokenSchema = z.enum(THEME_TOKEN_NAMES)
const ThemeSeedsSchema = z
  .object(
    Object.fromEntries([
      ...THEME_CORE_SEED_NAMES.map((name) => [name, OpaqueHexColorSchema]),
      ...THEME_SYNTAX_SEED_NAMES.map((name) => [name, OpaqueHexColorSchema.optional()]),
    ]) as Record<ThemeAllSeedName, z.ZodTypeAny>,
  )
  .strict()
const ThemeVariantSchema = z
  .object({
    seeds: ThemeSeedsSchema,
    overrides: z.partialRecord(ThemeTokenSchema, ColorValueSchema).optional(),
  })
  .strict()

export const ThemeSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    id: z.string().regex(new RegExp(THEME_ID_PATTERN)),
    light: ThemeVariantSchema,
    dark: ThemeVariantSchema,
  })
  .strict()

export function parseTheme(input: unknown): Theme {
  const parsed = ThemeSchema.parse(input)
  // Validation path: keep the parsed theme shape intact (nine-seed input stays
  // nine-seed). The resolver normalizes missing syntax seeds at the boundary
  // (resolveThemeVariant -> normalizeSeedColors), so downstream consumers and
  // equality assertions see the exact input they passed.
  resolveTheme(parsed as unknown as Theme)
  return parsed as unknown as Theme
}

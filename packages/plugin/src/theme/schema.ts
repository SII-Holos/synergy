import z from "zod"
import {
  CSS_VAR_REF_PATTERN,
  HEX_COLOR_PATTERN,
  OPAQUE_HEX_COLOR_PATTERN,
  THEME_CORE_SEED_NAMES,
  THEME_ID_PATTERN,
  THEME_SEED_NAMES,
  THEME_SYNTAX_SEED_NAMES,
  type ThemeSeedName,
} from "./schema-contract.js"
import { THEME_TOKEN_NAMES, THEME_TOKEN_SET } from "./tokens.js"
import type { HexColor, Theme, ThemeSeedColors, ThemeVariant } from "./types.js"
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
    ]) as Record<ThemeSeedName, z.ZodTypeAny>,
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
  const normalizeSeeds = (seeds: Partial<ThemeSeedColors>): ThemeSeedColors => ({
    neutral: seeds.neutral as HexColor,
    primary: seeds.primary as HexColor,
    success: seeds.success as HexColor,
    warning: seeds.warning as HexColor,
    error: seeds.error as HexColor,
    info: seeds.info as HexColor,
    interactive: seeds.interactive as HexColor,
    diffAdd: seeds.diffAdd as HexColor,
    diffDelete: seeds.diffDelete as HexColor,
    syntaxString: (seeds.syntaxString ?? seeds.success) as HexColor,
    syntaxKeyword: (seeds.syntaxKeyword ?? seeds.primary) as HexColor,
    syntaxType: (seeds.syntaxType ?? seeds.info) as HexColor,
    syntaxProperty: (seeds.syntaxProperty ?? seeds.interactive) as HexColor,
  })
  const theme: Theme = {
    ...parsed,
    light: {
      ...parsed.light,
      seeds: normalizeSeeds(parsed.light.seeds as Partial<ThemeSeedColors>),
      overrides: parsed.light.overrides as ThemeVariant["overrides"],
    },
    dark: {
      ...parsed.dark,
      seeds: normalizeSeeds(parsed.dark.seeds as Partial<ThemeSeedColors>),
      overrides: parsed.dark.overrides as ThemeVariant["overrides"],
    },
  }
  resolveTheme(theme)
  return theme
}

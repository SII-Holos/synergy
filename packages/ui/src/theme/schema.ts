import z from "zod"
import { THEME_TOKEN_NAMES, THEME_TOKEN_SET } from "./tokens"
import type { Theme } from "./types"

const HexColorSchema = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)
const CssVarRefSchema = z
  .string()
  .regex(/^var\(--[a-z0-9-]+\)$/)
  .refine((value) => THEME_TOKEN_SET.has(value.slice(6, -1)), "CSS variable must reference a canonical theme token")
const ColorValueSchema = z.union([HexColorSchema, CssVarRefSchema])
const ThemeTokenSchema = z.enum(THEME_TOKEN_NAMES)
const ThemeSeedsSchema = z
  .object({
    neutral: HexColorSchema,
    primary: HexColorSchema,
    success: HexColorSchema,
    warning: HexColorSchema,
    error: HexColorSchema,
    info: HexColorSchema,
    interactive: HexColorSchema,
    diffAdd: HexColorSchema,
    diffDelete: HexColorSchema,
  })
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
    id: z.string().regex(/^[a-z0-9-]+$/),
    light: ThemeVariantSchema,
    dark: ThemeVariantSchema,
  })
  .strict()

export function parseTheme(input: unknown): Theme {
  return ThemeSchema.parse(input) as Theme
}

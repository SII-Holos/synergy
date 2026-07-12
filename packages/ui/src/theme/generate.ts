import { resolveTheme, themeToCss } from "./resolve"
import { HEX_COLOR_PATTERN, OPAQUE_HEX_COLOR_PATTERN, THEME_ID_PATTERN, THEME_SEED_NAMES } from "./schema-contract"
import { THEME_TOKEN_NAMES } from "./tokens"
import type { ResolvedTheme, Theme } from "./types"

function declarations(tokens: ResolvedTheme, indentation: string) {
  return themeToCss(tokens)
    .split("\n")
    .map((line) => `${indentation}${line.trim()}`)
    .join("\n")
}

export function renderThemeFallbackCss(theme: Theme): string {
  const resolved = resolveTheme(theme)
  return `/* Generated from the canonical theme resolver. Do not edit manually. */

:root:not([data-color-scheme]) {
  color-scheme: light;
  --text-mix-blend-mode: multiply;
${declarations(resolved.light, "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-color-scheme]) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;
${declarations(resolved.dark, "    ")}
  }
}
`
}

export function renderTailwindColorsCss(): string {
  const mappings = THEME_TOKEN_NAMES.map((name) => `  --color-${name}: var(--${name});`).join("\n")
  return `/* Generated from the canonical theme token contract. Do not edit manually. */

@theme {
  --color-*: initial;
${mappings}
}
`
}

export function renderThemeSchemaJson(): string {
  const seedProperties = Object.fromEntries(
    THEME_SEED_NAMES.map((name) => [name, { $ref: "#/definitions/OpaqueHexColor" }]),
  )
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "./theme.schema.json",
    title: "Synergy Theme",
    description: "A complete Synergy color theme generated from light and dark seed palettes.",
    type: "object",
    additionalProperties: false,
    required: ["name", "id", "light", "dark"],
    properties: {
      $schema: { type: "string" },
      name: { type: "string", minLength: 1 },
      id: { type: "string", pattern: THEME_ID_PATTERN },
      light: { $ref: "#/definitions/ThemeVariant" },
      dark: { $ref: "#/definitions/ThemeVariant" },
    },
    definitions: {
      HexColor: { type: "string", pattern: HEX_COLOR_PATTERN },
      OpaqueHexColor: { type: "string", pattern: OPAQUE_HEX_COLOR_PATTERN },
      ColorValue: {
        oneOf: [{ $ref: "#/definitions/HexColor" }, { enum: THEME_TOKEN_NAMES.map((name) => `var(--${name})`) }],
      },
      ThemeSeedColors: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(seedProperties),
        properties: seedProperties,
      },
      ThemeVariant: {
        type: "object",
        additionalProperties: false,
        required: ["seeds"],
        properties: {
          seeds: { $ref: "#/definitions/ThemeSeedColors" },
          overrides: {
            type: "object",
            propertyNames: { enum: [...THEME_TOKEN_NAMES] },
            additionalProperties: { $ref: "#/definitions/ColorValue" },
          },
        },
      },
    },
  }
  return `${JSON.stringify(schema, null, 2)}\n`
}

import { describe, expect, test } from "bun:test"
import {
  CSS_VAR_REF_PATTERN,
  HEX_COLOR_PATTERN,
  OPAQUE_HEX_COLOR_PATTERN,
  THEME_CONTRAST_REQUIREMENTS,
  THEME_ID_PATTERN,
  THEME_SEED_NAMES,
  THEME_TOKEN_NAMES,
  THEME_TOKEN_SET,
  ThemeSchema,
  parseTheme,
  renderThemeSchemaJson,
  resolveTheme,
  resolveThemeColor,
  resolveThemeVariant,
  themeToCss,
  type Theme,
} from "../src/theme/index"

const lightSeeds = {
  neutral: "#6B6B6B",
  primary: "#3B82F6",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  info: "#3B82F6",
  interactive: "#3B82F6",
  diffAdd: "#22C55E",
  diffDelete: "#EF4444",
} as const

const darkSeeds = {
  neutral: "#9CA3AF",
  primary: "#60A5FA",
  success: "#4ADE80",
  warning: "#FBBF24",
  error: "#F87171",
  info: "#38BDF8",
  interactive: "#60A5FA",
  diffAdd: "#4ADE80",
  diffDelete: "#F87171",
} as const

function fixtureTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    name: "Coverage Fixture",
    id: "coverage-fixture",
    light: { seeds: { ...lightSeeds } },
    dark: { seeds: { ...darkSeeds } },
    ...overrides,
  }
}

const hexValue = /^#[0-9a-fA-F]{3,8}$/

describe("theme schema contract", () => {
  test("exposes the seed names, token names, and regex contracts", () => {
    expect(THEME_SEED_NAMES).toHaveLength(9)
    expect(THEME_SEED_NAMES).toContain("neutral")
    expect(THEME_SEED_NAMES).toContain("diffDelete")

    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length)
    expect(THEME_TOKEN_SET.has("text-base")).toBe(true)
    expect(THEME_TOKEN_SET.has("chart-series-9")).toBe(true)
    expect(THEME_TOKEN_SET.has("avatar-background-cyan")).toBe(true)
    expect(THEME_TOKEN_SET.has("not-a-token")).toBe(false)

    expect(new RegExp(HEX_COLOR_PATTERN).test("#abc")).toBe(true)
    expect(new RegExp(HEX_COLOR_PATTERN).test("#abcd")).toBe(true)
    expect(new RegExp(HEX_COLOR_PATTERN).test("#aabbcc")).toBe(true)
    expect(new RegExp(HEX_COLOR_PATTERN).test("#aabbccdd")).toBe(true)
    expect(new RegExp(HEX_COLOR_PATTERN).test("#aabbc")).toBe(false)
    expect(new RegExp(OPAQUE_HEX_COLOR_PATTERN).test("#aabbccdd")).toBe(false)
    expect(new RegExp(CSS_VAR_REF_PATTERN).test("var(--text-base)")).toBe(true)
    expect(new RegExp(CSS_VAR_REF_PATTERN).test("#ffffff")).toBe(false)
    expect(new RegExp(THEME_ID_PATTERN).test("coverage-fixture")).toBe(true)
    expect(new RegExp(THEME_ID_PATTERN).test("Bad Id")).toBe(false)
  })

  test("renders a draft-07 JSON schema that mirrors the canonical token contract", () => {
    const schema = JSON.parse(renderThemeSchemaJson())
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#")
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["name", "id", "light", "dark"])
    expect(schema.properties.id.pattern).toBe(THEME_ID_PATTERN)
    expect(schema.definitions.ThemeSeedColors.required).toHaveLength(9)
    expect(schema.definitions.CssVarRef.enum).toHaveLength(THEME_TOKEN_NAMES.length)
    expect(schema.definitions.OpaqueHexColor.pattern).toBe(OPAQUE_HEX_COLOR_PATTERN)
  })
})

describe("ThemeSchema", () => {
  test("accepts a seed-complete theme", () => {
    expect(ThemeSchema.parse(fixtureTheme()).id).toBe("coverage-fixture")
  })

  test("rejects malformed themes with the offending field", () => {
    const invalidCases: Array<[string, unknown]> = [
      ["missing variant", { ...fixtureTheme(), dark: undefined }],
      ["invalid id", fixtureTheme({ id: "Bad Id" })],
      ["missing seed", { ...fixtureTheme(), light: { seeds: { ...lightSeeds, error: undefined } } }],
      ["unknown seed", { ...fixtureTheme(), light: { seeds: { ...lightSeeds, extra: "#123456" } } }],
      ["invalid hex", { ...fixtureTheme(), light: { seeds: { ...lightSeeds, error: "#12" } } }],
      [
        "invalid css var",
        { ...fixtureTheme(), light: { seeds: lightSeeds, overrides: { "border-color": "var(--nope)" } } },
      ],
      [
        "unknown override token",
        { ...fixtureTheme(), light: { seeds: lightSeeds, overrides: { "not-a-token": "#123456" } } },
      ],
    ]
    for (const [label, input] of invalidCases) {
      const result = ThemeSchema.safeParse(input)
      expect(result.success, label).toBe(false)
    }
  })

  test("rejects css vars that reference unknown tokens even when the pattern matches", () => {
    const theme = fixtureTheme()
    theme.light.overrides = { "border-color": "var(--text-nope)" }
    expect(ThemeSchema.safeParse(theme).success).toBe(false)
  })
})

describe("resolveTheme", () => {
  test("resolves every canonical token for both variants", () => {
    const { light, dark } = resolveTheme(fixtureTheme())
    for (const variant of [light, dark]) {
      expect(Object.keys(variant).sort()).toEqual([...THEME_TOKEN_NAMES].sort())
      for (const value of Object.values(variant)) {
        expect(value).toMatch(/^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\))$/)
      }
    }
    expect(light["background-base"]).not.toBe(dark["background-base"])
    expect(light["chart-series-1"]).toBeDefined()
    expect(dark["chart-series-9"]).toBeDefined()
  })

  test("resolveThemeVariant and resolveTheme agree for the light variant", () => {
    const theme = fixtureTheme()
    expect(resolveThemeVariant(theme.light, false)).toEqual(resolveTheme(theme).light)
  })

  test("resolveThemeColor resolves direct hex values and css var chains", () => {
    const { light } = resolveTheme(fixtureTheme())
    expect(resolveThemeColor(light, "background-base")).toMatch(hexValue)
    expect(resolveThemeColor(light, "syntax-comment")).toBe(resolveThemeColor(light, "text-weak"))
    expect(resolveThemeColor(light, "text-weak")).toMatch(hexValue)
  })

  test("resolveThemeColor reports unknown references and cyclic chains", () => {
    const { light } = resolveTheme(fixtureTheme())
    expect(() =>
      resolveThemeColor({ ...light, "border-color": "var(--not-a-token)" } as never, "border-color"),
    ).toThrow(/Unknown theme token reference/)
    expect(() =>
      resolveThemeColor(
        { ...light, "text-weak": "var(--text-weaker)", "text-weaker": "var(--text-weak)" } as never,
        "text-weak",
      ),
    ).toThrow(/Cyclic theme token reference/)
  })

  test("THEME_CONTRAST_REQUIREMENTS covers resolvable token pairs", () => {
    const { light, dark } = resolveTheme(fixtureTheme())
    expect(THEME_CONTRAST_REQUIREMENTS.length).toBeGreaterThan(0)
    for (const requirement of THEME_CONTRAST_REQUIREMENTS) {
      expect(requirement.minimum === 3 || requirement.minimum === 4.5).toBe(true)
      expect(() => resolveThemeColor(light, requirement.foreground)).not.toThrow()
      expect(() => resolveThemeColor(dark, requirement.background)).not.toThrow()
    }
  })

  test("rejects themes whose overrides violate the contrast contract", () => {
    const theme = fixtureTheme()
    theme.light.overrides = { "text-base": "#f8f8f8" }
    expect(() => parseTheme(theme)).toThrow(/contrast requirement failed/)
  })

  test("rejects cyclic override references during resolution", () => {
    const theme = fixtureTheme()
    theme.light.overrides = { "border-base": "var(--border-base)" }
    expect(() => parseTheme(theme)).toThrow(/Cyclic theme token reference/)
  })

  test("themeToCss renders one custom property per token", () => {
    const { light } = resolveTheme(fixtureTheme())
    const css = themeToCss(light)
    expect(css).toContain("--background-base: #")
    expect(css).toContain("--chart-series-9: #")
    expect(css.split("\n")).toHaveLength(THEME_TOKEN_NAMES.length)
  })
})

describe("parseTheme", () => {
  test("validates and resolves a theme in one step", () => {
    const theme = fixtureTheme()
    const parsed = parseTheme(theme)
    expect(parsed).toEqual(theme)
    expect(resolveTheme(parsed).light["text-base"]).toMatch(hexValue)
  })

  test("rejects themes that fail the resolver", () => {
    expect(() =>
      parseTheme(fixtureTheme({ light: { seeds: lightSeeds, overrides: { "text-base": "#ffffff" } } })),
    ).toThrow()
  })
})

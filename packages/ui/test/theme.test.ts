import { describe, test, expect } from "bun:test"
import {
  resolveThemeVariant,
  resolveTheme,
  resolveThemeColor,
  themeToCss,
  THEME_CONTRAST_REQUIREMENTS,
} from "../src/theme/resolve"
import { synergyTheme } from "../src/theme/default-themes"
import { getSavedColorScheme, getSystemMode, isColorScheme, resolveColorSchemeMode } from "../src/theme/color-scheme"
import { THEME_TOKEN_NAMES, type ThemeTokenName } from "../src/theme/tokens"
import { parseTheme } from "../src/theme/schema"
import { hexToRgb, withAlpha } from "../src/theme/color"
import type { ResolvedTheme } from "../src/theme/types"

// ── Helpers ──────────────────────────────────────────────────

function allTokens(theme: ResolvedTheme): ThemeTokenName[] {
  return (Object.keys(theme) as ThemeTokenName[]).sort()
}

test("resolves CSS variable references for imperative consumers", () => {
  const resolved = resolveTheme(synergyTheme).light
  expect(resolveThemeColor(resolved, "syntax-comment")).toBe(resolveThemeColor(resolved, "text-weaker"))
})

function luminance(value: string): number {
  const hex = value.trim()
  if (!hex.startsWith("#")) throw new Error(`Expected hex color for luminance check, got ${value}`)
  const normalized = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) throw new Error(`Unsupported color value: ${value}`)
  const channels = [1, 3, 5].map((start) => Number.parseInt(normalized.slice(start, start + 2), 16) / 255)
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

function expectReadablePair(theme: ResolvedTheme, foreground: ThemeTokenName, background: ThemeTokenName) {
  expect(contrastRatio(theme[foreground], theme[background])).toBeGreaterThanOrEqual(4.5)
}

function expectBrighter(theme: ResolvedTheme, inner: ThemeTokenName, outer: ThemeTokenName) {
  expect(luminance(theme[inner])).toBeGreaterThan(luminance(theme[outer]))
}

function expectAtLeastAsBright(theme: ResolvedTheme, inner: ThemeTokenName, outer: ThemeTokenName) {
  expect(luminance(theme[inner])).toBeGreaterThanOrEqual(luminance(theme[outer]))
}

function expectAtMostAsBright(theme: ResolvedTheme, inner: ThemeTokenName, outer: ThemeTokenName) {
  expect(luminance(theme[inner])).toBeLessThanOrEqual(luminance(theme[outer]))
}

/**
 * CSS consumers that reference these tokens IN PRODUCTION.
 * Every entry here MUST be present in resolved output.
 *
 * Sources scanned:
 *   packages/app/src/components/**\/*.tsx
 *   packages/ui/src/components/**\/*.css
 *   packages/ui/src/components/**\/*.tsx
 */
const CONSUMER_REQUIRED_TOKENS = [
  // ── text ───────────────────────────────────────────
  "text-base",
  "text-weak",
  "text-weaker",
  "text-strong",
  "text-subtle", // ★ currently MISSING — ~50+ css/tailwind references
  "text-error", // ★ currently MISSING — switch/checkbox/question-prompt
  "text-stronger", // ★ currently MISSING — terminal.tsx fallback
  "text-interactive-base",

  // ── surface ────────────────────────────────────────
  "surface-base",
  "surface-disabled", // ★ currently MISSING — button/switch/checkbox
  "surface-focus", // ★ currently MISSING — icon-button/switch/checkbox/markdown
  "surface-hover", // ★ currently MISSING — switch/checkbox
  "surface-hover-base", // ★ currently MISSING — session-turn/resonance-popover
  "surface-weak",
  "surface-raised-base",
  "surface-inset-base",
  "surface-raised-stronger-non-alpha",

  // ── border ─────────────────────────────────────────
  "border-base",
  "border-error", // ★ currently MISSING — switch/checkbox
  "border-disabled",
  "border-focus",
  "border-hover",
  "border-weak-base",

  // ── icon ───────────────────────────────────────────
  "icon-base",
  "icon-disabled",

  // ── fonts / metrics ────────────────────────────────
  // NOTE: --line-height-normal, --font-size-* etc are
  // design-token level, not theme-color level. Their
  // source is likely tailwind base or _variables.css.
  // Skipping here — not a theme-color concern.

  // ── button ─────────────────────────────────────────
  "button-secondary-base",
  "button-secondary-hover",

  // ── background ─────────────────────────────────────
  "background-base",
  "background-weak",
  "background-strong",
  "background-stronger",
]

describe("color scheme helpers", () => {
  test("parses saved color scheme values", () => {
    const storage = { getItem: () => "dark" }
    expect(getSavedColorScheme(storage)).toBe("dark")
    expect(isColorScheme("light")).toBe(true)
    expect(isColorScheme("dark")).toBe(true)
    expect(isColorScheme("system")).toBe(true)
  })

  test("returns null for invalid saved color scheme values", () => {
    expect(getSavedColorScheme({ getItem: () => "blue" })).toBeNull()
    expect(getSavedColorScheme({ getItem: () => null })).toBeNull()
    expect(
      getSavedColorScheme({
        getItem: () => {
          throw new Error("blocked")
        },
      }),
    ).toBeNull()
    expect(isColorScheme("blue")).toBe(false)
  })

  test("resolves system mode from matchMedia", () => {
    expect(getSystemMode(() => ({ matches: true }) as MediaQueryList)).toBe("dark")
    expect(getSystemMode(() => ({ matches: false }) as MediaQueryList)).toBe("light")
    expect(resolveColorSchemeMode("light")).toBe("light")
    expect(resolveColorSchemeMode("dark")).toBe("dark")
  })

  test("defaults missing saved color scheme to system", () => {
    expect(getSavedColorScheme({ getItem: () => null }) ?? "system").toBe("system")
  })
})

describe("resolveTheme (synergy)", () => {
  // ── Contract: only 2 themes exist ───────────────────────

  test("produces exactly light and dark variants", () => {
    const resolved = resolveTheme(synergyTheme)
    expect(Object.keys(resolved).sort()).toEqual(["dark", "light"])
  })

  test("light and dark are non-empty token maps", () => {
    const resolved = resolveTheme(synergyTheme)
    const lightTokens = Object.keys(resolved.light)
    const darkTokens = Object.keys(resolved.dark)
    expect(lightTokens.length).toBeGreaterThan(50)
    expect(darkTokens.length).toBeGreaterThan(50)
  })

  test("light and dark produce identical token names", () => {
    const resolved = resolveTheme(synergyTheme)
    const lightNames = allTokens(resolved.light)
    const darkNames = allTokens(resolved.dark)
    expect(lightNames).toEqual(darkNames)
  })

  test("resolved variants exactly match the canonical token contract", () => {
    const resolved = resolveTheme(synergyTheme)
    expect(allTokens(resolved.light)).toEqual([...THEME_TOKEN_NAMES].sort())
    expect(allTokens(resolved.dark)).toEqual([...THEME_TOKEN_NAMES].sort())
  })

  test("a second seed-only theme resolves the complete token contract", () => {
    const theme = parseTheme({
      name: "Ember Test",
      id: "ember-test",
      light: {
        seeds: {
          neutral: "#756f69",
          primary: "#9a5b32",
          success: "#34845c",
          warning: "#a76d19",
          error: "#b34b42",
          info: "#557ca7",
          interactive: "#7556a8",
          diffAdd: "#34845c",
          diffDelete: "#b34b42",
        },
      },
      dark: {
        seeds: {
          neutral: "#aaa29a",
          primary: "#d48652",
          success: "#55b77f",
          warning: "#d8a44d",
          error: "#dc7268",
          info: "#7fa8d2",
          interactive: "#a98bd4",
          diffAdd: "#55b77f",
          diffDelete: "#dc7268",
        },
      },
    })
    const resolved = resolveTheme(theme)
    expect(allTokens(resolved.light)).toEqual([...THEME_TOKEN_NAMES].sort())
    expect(allTokens(resolved.dark)).toEqual([...THEME_TOKEN_NAMES].sort())
    for (const variant of [resolved.light, resolved.dark]) {
      expectReadablePair(variant, "text-on-interactive-base", "surface-interactive-solid")
      expectReadablePair(variant, "text-on-success-base", "surface-success-weak")
      expectReadablePair(variant, "text-on-warning-base", "surface-warning-weak")
      expectReadablePair(variant, "text-on-critical-base", "surface-critical-weak")
    }
    expectAtLeastAsBright(resolved.light, "surface-float-base", "background-stronger")
    expectAtMostAsBright(resolved.light, "surface-float-base-hover", "surface-float-base")
    expectBrighter(resolved.dark, "surface-float-base", "background-stronger")
  })

  test("theme parsing rejects unknown tokens and unsupported color syntax", () => {
    expect(() =>
      parseTheme({
        ...synergyTheme,
        light: {
          ...synergyTheme.light,
          overrides: { ...synergyTheme.light.overrides, "unknown-token": "#ffffff" },
        },
      }),
    ).toThrow()

    expect(() =>
      parseTheme({
        ...synergyTheme,
        dark: {
          ...synergyTheme.dark,
          overrides: { ...synergyTheme.dark.overrides, "border-base": "rgba(255, 255, 255, 0.2)" },
        },
      }),
    ).toThrow()

    expect(() =>
      parseTheme({
        ...synergyTheme,
        light: {
          ...synergyTheme.light,
          overrides: { ...synergyTheme.light.overrides, "border-base": "var(--unknown-token)" },
        },
      }),
    ).toThrow()
  })

  test("theme parsing rejects cyclic token references before registration", () => {
    expect(() =>
      parseTheme({
        ...synergyTheme,
        light: {
          ...synergyTheme.light,
          overrides: { ...synergyTheme.light.overrides, "border-base": "var(--border-base)" },
        },
      }),
    ).toThrow("Cyclic theme token reference")
  })

  test("theme parsing rejects translucent seed colors", () => {
    expect(() =>
      parseTheme({
        ...synergyTheme,
        light: {
          ...synergyTheme.light,
          seeds: { ...synergyTheme.light.seeds, primary: "#ff000080" },
        },
      }),
    ).toThrow()
  })

  test("dark status foregrounds remain readable for dark author seeds", () => {
    const seeds = {
      ...synergyTheme.dark.seeds,
      error: "#7f1d1d",
    }
    const theme = parseTheme({
      name: "Dark Red Test",
      id: "dark-red-test",
      light: { seeds: synergyTheme.light.seeds },
      dark: { seeds },
    })
    const resolved = resolveTheme(theme)
    expectReadablePair(resolved.dark, "text-on-critical-base", "surface-critical-weak")
  })

  test("theme parsing rejects overrides that break required contrast pairs", () => {
    expect(() =>
      parseTheme({
        ...synergyTheme,
        dark: {
          ...synergyTheme.dark,
          overrides: {
            ...synergyTheme.dark.overrides,
            "surface-critical-weak": "#111111",
            "text-on-critical-base": "#121212",
          },
        },
      }),
    ).toThrow("Theme contrast requirement failed")
  })

  // ── Contract: every consumer-referenced token exists ────

  for (const token of CONSUMER_REQUIRED_TOKENS) {
    test(`token exists: --${token}`, () => {
      const resolved = resolveTheme(synergyTheme)
      expect(token in resolved.light).toBe(true)
      expect(token in resolved.dark).toBe(true)
    })
  }

  // ── Contract: token values have stable shapes ───────────

  test("every token value is a hex or var() reference", () => {
    const resolved = resolveTheme(synergyTheme)
    for (const [key, value] of Object.entries(resolved.light)) {
      const valid =
        (typeof value === "string" && value.startsWith("#")) ||
        (typeof value === "string" && value.startsWith("var(--"))
      if (!valid) {
        throw new Error(`light token --${key} has non-conformant value: ${JSON.stringify(value)}`)
      }
    }
  })

  test("no token value is undefined or empty", () => {
    const resolved = resolveTheme(synergyTheme)
    for (const mode of ["light", "dark"] as const) {
      for (const [key, value] of Object.entries(resolved[mode])) {
        expect(value).toBeTruthy()
      }
    }
  })

  // ── Contract: dark tokens exist and differ from light ────

  test("dark variant has at least one color differing from light", () => {
    const resolved = resolveTheme(synergyTheme)
    const diffs = (Object.keys(resolved.light) as ThemeTokenName[]).filter(
      (key) => resolved.light[key] !== resolved.dark[key],
    )
    expect(diffs.length).toBeGreaterThan(3)
  })

  test("surface polarity follows the neutral workbench product rule", () => {
    const resolved = resolveTheme(synergyTheme)

    expect(resolved.light["background-stronger"]).toBe("#FAFAFA")
    expect(resolved.light["surface-raised-base"]).toBe("#FFFFFF")
    expect(resolved.light["surface-raised-stronger-non-alpha"]).toBe("#FFFFFF")
    expect(resolved.light["surface-float-base"]).toBe("#FFFFFF")
    expect(resolved.light["surface-inset-base"]).toBe("#F4F4F5")
    expect(resolved.light["surface-interactive-selected"]).toBe("#F1F2F4")

    expectAtLeastAsBright(resolved.light, "surface-raised-base", "background-stronger")
    expectAtLeastAsBright(resolved.light, "surface-raised-strong", "surface-raised-base")
    expectAtLeastAsBright(resolved.light, "surface-raised-stronger", "surface-raised-base")
    expectAtLeastAsBright(resolved.light, "surface-raised-stronger-non-alpha", "surface-raised-base")
    expectAtLeastAsBright(resolved.light, "surface-float-base", "background-stronger")
    expectAtMostAsBright(resolved.light, "surface-raised-base-hover", "surface-raised-base")
    expectAtMostAsBright(resolved.light, "surface-float-base-hover", "surface-float-base")
    expectAtMostAsBright(resolved.light, "surface-raised-base-active", "surface-raised-base")
    expectAtMostAsBright(resolved.light, "surface-inset-base", "surface-raised-base")
    expectAtMostAsBright(resolved.light, "surface-interactive-selected", "surface-raised-base")
    expectAtMostAsBright(resolved.light, "input-base", "surface-raised-base")
    expectAtMostAsBright(resolved.light, "button-secondary-base", "surface-raised-base")

    expectBrighter(resolved.dark, "surface-raised-base", "background-stronger")
    expectBrighter(resolved.dark, "surface-raised-strong", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-raised-stronger", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-raised-stronger-hover", "surface-raised-stronger")
    expectBrighter(resolved.dark, "surface-raised-stronger-non-alpha", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-raised-base-active", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-inset-base", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-interactive-selected", "surface-raised-base")
    expectBrighter(resolved.dark, "surface-float-base", "background-stronger")
    expectBrighter(resolved.dark, "input-base", "surface-raised-base")
    expectBrighter(resolved.dark, "button-secondary-base", "surface-raised-base")
  })

  test("categorical chart series stay complete and visually distinct in both modes", () => {
    const series = THEME_TOKEN_NAMES.filter((token) => token.startsWith("chart-series-"))
    expect(series).toHaveLength(9)

    const resolved = resolveTheme(synergyTheme)
    for (const variant of [resolved.light, resolved.dark]) {
      const colors = series.map((token) => resolveThemeColor(variant, token))
      expect(new Set(colors).size).toBeGreaterThanOrEqual(7)
    }
  })

  test("semantic foreground and surface pairs meet WCAG AA contrast", () => {
    const resolved = resolveTheme(synergyTheme)
    for (const variant of [resolved.light, resolved.dark]) {
      for (const requirement of THEME_CONTRAST_REQUIREMENTS) {
        expect(
          contrastRatio(
            resolveThemeColor(variant, requirement.foreground),
            resolveThemeColor(variant, requirement.background),
          ),
        ).toBeGreaterThanOrEqual(requirement.minimum)
      }
    }
  })

  // ── CSS output ──────────────────────────────────────────

  test("themeToCss produces valid CSS custom properties", () => {
    const variant = synergyTheme.light
    const tokens = resolveThemeVariant(variant, false)
    const css = themeToCss(tokens)
    expect(css).toContain("--text-base:")
    expect(css).toContain("--background-base:")
    expect(css).not.toContain(": undefined")
  })

  test("themeToCss output ends with semicolons per line", () => {
    const variant = synergyTheme.light
    const tokens = resolveThemeVariant(variant, false)
    const css = themeToCss(tokens)
    const lines = css.split("\n").filter(Boolean)
    for (const line of lines) {
      expect(line.trimEnd()).toMatch(/;$/)
    }
  })

  // ── Theme variant seeds ─────────────────────────────────

  test("synergyTheme has valid light and dark seeds", () => {
    expect(synergyTheme.light.seeds.neutral).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(synergyTheme.light.seeds.primary).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(synergyTheme.dark.seeds.neutral).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(synergyTheme.dark.seeds.primary).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  test("synergyTheme id is 'synergy'", () => {
    expect(synergyTheme.id).toBe("synergy")
  })
})

describe("hex color helpers", () => {
  test("reads RGB channels without shifting eight-digit alpha input", () => {
    expect(hexToRgb("#ff000080")).toEqual({ r: 1, g: 0, b: 0 })
  })

  test("writes alpha as canonical eight-digit hex", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("#ff000080")
  })
})

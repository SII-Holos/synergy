import { describe, test, expect } from "bun:test"
import { resolveThemeVariant, resolveTheme, themeToCss } from "../src/theme/resolve"
import { synergyTheme } from "../src/theme/default-themes"
import type { ResolvedTheme } from "../src/theme/types"

// ── Helpers ──────────────────────────────────────────────────

function allTokens(theme: ResolvedTheme): string[] {
  return Object.keys(theme).sort()
}

function luminance(value: string): number {
  const hex = value.trim()
  if (!hex.startsWith("#")) throw new Error(`Expected hex color for luminance check, got ${value}`)
  const normalized =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) throw new Error(`Unsupported color value: ${value}`)
  const channels = [1, 3, 5].map((start) => Number.parseInt(normalized.slice(start, start + 2), 16) / 255)
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function expectDarker(theme: ResolvedTheme, inner: string, outer: string) {
  expect(luminance(theme[inner])).toBeLessThan(luminance(theme[outer]))
}

function expectBrighter(theme: ResolvedTheme, inner: string, outer: string) {
  expect(luminance(theme[inner])).toBeGreaterThan(luminance(theme[outer]))
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
        (typeof value === "string" && value.startsWith("rgba(")) ||
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
    const diffs = Object.keys(resolved.light).filter((key) => resolved.light[key] !== resolved.dark[key])
    expect(diffs.length).toBeGreaterThan(3)
  })

  test("surface polarity follows the Synergy product rule", () => {
    const resolved = resolveTheme(synergyTheme)

    expectDarker(resolved.light, "surface-raised-base", "background-stronger")
    expectDarker(resolved.light, "surface-raised-strong", "surface-raised-base")
    expectDarker(resolved.light, "surface-raised-stronger", "surface-raised-base")
    expectDarker(resolved.light, "surface-raised-stronger-hover", "surface-raised-stronger")
    expectDarker(resolved.light, "surface-raised-stronger-non-alpha", "surface-raised-base")
    expectDarker(resolved.light, "surface-raised-base-active", "surface-raised-base")
    expectDarker(resolved.light, "surface-inset-base", "surface-raised-base")
    expectDarker(resolved.light, "surface-interactive-selected", "surface-raised-base")
    expectDarker(resolved.light, "surface-float-base", "background-stronger")
    expectDarker(resolved.light, "input-base", "surface-raised-base")
    expectDarker(resolved.light, "button-secondary-base", "surface-raised-base")

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

import { describe, expect, test } from "bun:test"
import {
  contrastRatio,
  darken,
  generateCategoricalPalette,
  generateNeutralScale,
  generateScale,
  hexToOklch,
  hexToRgb,
  lighten,
  mixColors,
  oklchToHex,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
  withAlpha,
} from "../src/theme/color"

const hex = /^#[0-9a-f]{6}$/

function expectRgbClose(actual: { r: number; g: number; b: number }, expected: { r: number; g: number; b: number }) {
  expect(Math.abs(actual.r - expected.r)).toBeLessThan(0.01)
  expect(Math.abs(actual.g - expected.g)).toBeLessThan(0.01)
  expect(Math.abs(actual.b - expected.b)).toBeLessThan(0.01)
}

function expectHexClose(actual: string, expected: string) {
  const a = hexToRgb(actual as `#${string}`)
  const e = hexToRgb(expected as `#${string}`)
  expectRgbClose(a, e)
}

describe("color conversions", () => {
  test("hexToRgb decodes 3, 4, 6, and 8 digit hex", () => {
    expectRgbClose(hexToRgb("#abc"), hexToRgb("#aabbcc"))
    expectRgbClose(hexToRgb("#0af"), { r: 0, g: 170 / 255, b: 1 })
    expectRgbClose(hexToRgb("#808080"), { r: 0.502, g: 0.502, b: 0.502 })
  })

  test("hexToRgb rejects malformed hex", () => {
    expect(() => hexToRgb("#12345" as never)).toThrow(/Invalid hex color/)
    expect(() => hexToRgb("#gggggg" as never)).toThrow(/Invalid hex color/)
  })

  test("rgbToHex clamps and rounds", () => {
    expect(rgbToHex(1, 0, 0)).toBe("#ff0000")
    expect(rgbToHex(2, -1, 0.5)).toBe("#ff0080")
    expect(rgbToHex(0, 0, 0)).toBe("#000000")
  })

  test("rgbToOklch and oklchToRgb round-trip", () => {
    const oklch = rgbToOklch(0.5, 0.4, 0.3)
    const rgb = oklchToRgb(oklch)
    expectRgbClose(rgb, { r: 0.5, g: 0.4, b: 0.3 })
    expect(oklch.l).toBeGreaterThanOrEqual(0)
    expect(oklch.l).toBeLessThanOrEqual(1)
    expect(oklch.h).toBeGreaterThanOrEqual(0)
    expect(oklch.h).toBeLessThan(360)
  })

  test("hexToOklch and oklchToHex round-trip", () => {
    expectHexClose(oklchToHex(hexToOklch("#3B82F6")), "#3B82F6")
  })
})

describe("contrastRatio", () => {
  test("reports maximum contrast for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4)
  })

  test("is symmetric for opaque pairs", () => {
    expect(contrastRatio("#111111", "#eeeeee")).toBeCloseTo(contrastRatio("#eeeeee", "#111111"))
  })

  test("composites translucent foregrounds", () => {
    const direct = contrastRatio("#80808080", "#ffffff")
    expect(direct).toBeGreaterThan(1)
  })

  test("rejects translucent backgrounds", () => {
    expect(() => contrastRatio("#ffffff", "#ffffff80")).toThrow(/opaque/)
  })
})

describe("scale generation", () => {
  test("generateScale returns twelve hex colors", () => {
    for (const isDark of [false, true]) {
      const scale = generateScale("#3B82F6", isDark)
      expect(scale).toHaveLength(12)
      for (const color of scale) expect(color).toMatch(hex)
    }
    expect(generateScale("#3B82F6", false)).not.toEqual(generateScale("#3B82F6", true))
  })

  test("generateNeutralScale dampens chroma", () => {
    for (const isDark of [false, true]) {
      const scale = generateNeutralScale("#6B6B6B", isDark)
      expect(scale).toHaveLength(12)
      for (const color of scale) expect(color).toMatch(hex)
    }
  })

  test("generateCategoricalPalette returns nine distinguishable colors", () => {
    const palette = generateCategoricalPalette("#3B82F6", false)
    expect(palette).toHaveLength(9)
    expect(new Set(palette).size).toBe(9)
    for (const color of palette) expect(color).toMatch(hex)
  })
})

describe("color utilities", () => {
  test("mixColors interpolates in oklch", () => {
    expect(mixColors("#000000", "#ffffff", 0)).toMatch(hex)
    expect(mixColors("#000000", "#ffffff", 0.5)).toMatch(hex)
    expect(mixColors("#000000", "#ffffff", 1)).toMatch(hex)
    expectHexClose(mixColors("#000000", "#ffffff", 1), "#ffffff")
  })

  test("lighten and darken clamp lightness", () => {
    expect(lighten("#ffffff", 1).slice(1, 3)).toBe("ff")
    expect(darken("#000000", 1).slice(1, 3)).toBe("00")
    expect(lighten("#808080", 0.1)).toMatch(hex)
    expect(darken("#808080", 0.1)).toMatch(hex)
  })

  test("withAlpha appends a clamped alpha channel", () => {
    expect(withAlpha("#ffffff", 1)).toBe("#ffffffff")
    expect(withAlpha("#ffffff", 0)).toBe("#ffffff00")
    expect(withAlpha("#ffffff", 2)).toBe("#ffffffff")
    expect(withAlpha("#ffffff", -1)).toBe("#ffffff00")
    expect(withAlpha("#808080", 0.5)).toBe("#80808080")
  })
})

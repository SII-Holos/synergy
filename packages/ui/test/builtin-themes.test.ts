import { expect, test } from "bun:test"
import { builtinThemes } from "../src/theme/default-themes"
import { resolveTheme } from "../src/theme/resolve"
import { THEME_ALL_SEED_NAMES } from "../src/theme/schema-contract"
const MODES = ["light", "dark"] as const

test("built-in themes resolve both color schemes", () => {
  expect(builtinThemes.map((theme) => theme.id)).toEqual([
    "synergy",
    "catppuccin",
    "tokyo-night",
    "ayu",
    "rose-pine",
    "kanagawa",
    "everforest",
    "solarized",
  ])

  for (const theme of builtinThemes) {
    const resolved = resolveTheme(theme)
    expect(resolved.light["background-base"]).toBeDefined()
    expect(resolved.dark["background-base"]).toBeDefined()
    expect(resolved.light["surface-interactive-solid"]).toBeDefined()
    expect(resolved.dark["surface-interactive-solid"]).toBeDefined()
  }
})

test("provides 16 variants across 8 skins and both color schemes", () => {
  expect(builtinThemes).toHaveLength(8)
  let variants = 0
  for (const theme of builtinThemes) {
    const resolved = resolveTheme(theme)
    for (const mode of MODES) {
      const tokens = resolved[mode]
      expect(tokens["background-base"]).toBeDefined()
      expect(tokens["text-base"]).toBeDefined()
      expect(tokens["surface-interactive-solid"]).toBeDefined()
      variants += 1
    }
    expect(resolved.light["background-base"]).not.toBe(resolved.dark["background-base"])
  }
  expect(variants).toBe(8 * MODES.length)
})

test("all built-in themes carry the complete thirteen-seed set", () => {
  for (const theme of builtinThemes) {
    expect(Object.keys(theme.light.seeds).sort()).toEqual([...THEME_ALL_SEED_NAMES].sort())
    expect(Object.keys(theme.dark.seeds).sort()).toEqual([...THEME_ALL_SEED_NAMES].sort())
  }
})

test("curated skins other than Synergy stay seeds-only", () => {
  for (const theme of builtinThemes.filter((theme) => theme.id !== "synergy")) {
    expect(theme.light.overrides).toBeUndefined()
    expect(theme.dark.overrides).toBeUndefined()
  }
})

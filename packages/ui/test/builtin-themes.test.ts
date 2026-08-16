import { expect, test } from "bun:test"
import { builtinThemes } from "../src/theme/default-themes"
import { resolveTheme } from "../src/theme/resolve"
import { THEME_SEED_NAMES } from "../src/theme/schema-contract"

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

test("built-in themes use the complete seed pipeline without general overrides", () => {
  for (const theme of builtinThemes) {
    expect(Object.keys(theme.light.seeds).sort()).toEqual([...THEME_SEED_NAMES].sort())
    expect(Object.keys(theme.dark.seeds).sort()).toEqual([...THEME_SEED_NAMES].sort())
    expect(theme.light.overrides).toBeUndefined()
    expect(theme.dark.overrides).toBeUndefined()
  }
})

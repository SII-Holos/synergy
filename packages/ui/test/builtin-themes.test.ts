import { expect, test } from "bun:test"
import { builtinThemes } from "../src/theme/default-themes"
import { resolveTheme } from "../src/theme/resolve"

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

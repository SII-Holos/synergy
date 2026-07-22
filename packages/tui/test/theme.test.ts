import { describe, expect, test } from "bun:test"
import { getTuiPalette } from "../src/theme"

describe("Synergy TUI theme", () => {
  test("uses the canonical Synergy dark workbench hierarchy", () => {
    const palette = getTuiPalette("dark")

    expect(palette.background).toBe("#0F0F10")
    expect(palette.surface).toBe("#1B1B1D")
    expect(palette.surfaceInset).toBe("#222326")
    expect(palette.surfaceRaised).toBe("#2A2B2F")
    expect(palette.textStrong).toBe("#FAFAFA")
    expect(palette.text).toBe("#F4F4F5")
    expect(palette.textWeak).toBe("#D4D4D8")
    expect(palette.textWeaker).toBe("#A1A1AA")
    expect(palette.textSubtle).toBe("#71717A")
    expect(palette.interactive).toBe("#60A5FA")
  })

  test("keeps selection neutral and preserves surface polarity in both modes", () => {
    const dark = getTuiPalette("dark")
    const light = getTuiPalette("light")

    expect(dark.selected).toBe(dark.surfaceRaised)
    expect(dark.selected).not.toBe(dark.interactive)
    expect(light.selected).toBe("#F1F2F4")
    expect(light.selected).not.toBe(light.interactive)
    expect(dark.background).not.toBe(dark.surface)
    expect(light.background).not.toBe(light.surface)
  })
})

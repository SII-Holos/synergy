import { describe, expect, test } from "bun:test"
import { synergyTheme } from "../src/theme/default-themes"
import { renderThemeFallbackCss, renderThemeSchemaJson, renderTailwindColorsCss } from "../src/theme/generate"
import { THEME_TOKEN_NAMES } from "../src/theme/tokens"

describe("theme generated artifacts", () => {
  test("Tailwind exposes every canonical color token exactly once", () => {
    const css = renderTailwindColorsCss()
    const names = [...css.matchAll(/--color-([\w-]+):/g)].map((match) => match[1])
    expect(names).toEqual([...THEME_TOKEN_NAMES])
  })

  test("checked-in Tailwind mappings match the canonical generator", async () => {
    const css = await Bun.file("src/styles/tailwind/colors.css").text()
    expect(css).toBe(renderTailwindColorsCss())
  })

  test("checked-in static fallback matches the runtime theme resolver", async () => {
    const css = await Bun.file("src/styles/theme.generated.css").text()
    expect(css).toBe(renderThemeFallbackCss(synergyTheme))
  })

  test("checked-in JSON schema matches the canonical token contract", async () => {
    const schema = await Bun.file("src/theme/theme.schema.json").text()
    expect(schema).toBe(renderThemeSchemaJson())
  })
})

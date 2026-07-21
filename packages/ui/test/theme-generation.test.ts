import { describe, expect, test } from "bun:test"
import { synergyTheme } from "../src/theme/default-themes"
import {
  renderDesktopFallbackSkin,
  renderThemeFallbackCss,
  renderThemeSchemaJson,
  renderTailwindColorsCss,
  renderWebBootFallbackCss,
  renderWebThemeColorMeta,
} from "../src/theme/generate"
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

  test("checked-in Desktop fallback skin is generated from the same resolved theme", async () => {
    const source = await Bun.file("../desktop/src/default-shell-skin.generated.ts").text()
    expect(source).toBe(renderDesktopFallbackSkin(synergyTheme))
  })

  test("checked-in Web boot fallback skin is generated from the same resolved theme", async () => {
    const html = await Bun.file("../app/index.html").text()
    const match = html.match(
      /^      \/\* BEGIN GENERATED SKIN FALLBACK \*\/\n([\s\S]*?)\n      \/\* END GENERATED SKIN FALLBACK \*\//m,
    )
    expect(match?.[1]).toBe(renderWebBootFallbackCss(synergyTheme))
    expect(html).toContain(renderWebThemeColorMeta(synergyTheme))
  })
})

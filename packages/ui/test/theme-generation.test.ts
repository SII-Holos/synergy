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

  test("generates ribbon fallback colors in both modes and canonical Tailwind mappings", () => {
    const fallback = renderThemeFallbackCss(synergyTheme)
    const tailwind = renderTailwindColorsCss()
    for (const [token, color] of [
      ["brand-ribbon-start", "#92bf46"],
      ["brand-ribbon-middle", "#4f9bb6"],
      ["brand-ribbon-end", "#5e52b4"],
    ]) {
      const values = [...fallback.matchAll(new RegExp(`--${token}: (#[0-9a-fA-F]+);`, "g"))].map((match) => match[1])
      expect(values).toEqual([color, color])
      expect(tailwind).toContain(`--color-${token}: var(--${token});`)
    }
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
    const source = await Bun.file("../../apps/desktop/src/default-shell-skin.generated.ts").text()
    expect(source).toBe(renderDesktopFallbackSkin(synergyTheme))
  })

  test("checked-in Web boot fallback skin is generated from the same resolved theme", async () => {
    const html = await Bun.file("../../apps/web/index.html").text()
    const match = html.match(
      /^      \/\* BEGIN GENERATED SKIN FALLBACK \*\/\n([\s\S]*?)\n      \/\* END GENERATED SKIN FALLBACK \*\//m,
    )
    expect(match?.[1]).toBe(renderWebBootFallbackCss(synergyTheme))
    expect(html).toContain(renderWebThemeColorMeta(synergyTheme))
  })
})

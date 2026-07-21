import { afterEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import {
  applyThemeToDocument,
  getAppliedTheme,
  THEME_CHANGE_EVENT,
  type ThemeChangeDetail,
} from "../src/theme/application"
import { resolveTheme, resolveThemeColor } from "../src/theme/resolve"
import { synergyTheme } from "../src/theme/default-themes"

describe("theme application", () => {
  let dom: JSDOM | undefined

  afterEach(() => dom?.window.close())

  test("notifies imperative consumers when the theme changes without changing color scheme", () => {
    dom = new JSDOM('<!doctype html><html><head><meta name="theme-color"></head><body></body></html>')
    const events: string[] = []
    dom.window.document.addEventListener(THEME_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent<ThemeChangeDetail>).detail.themeId)
    })
    const resolved = resolveTheme(synergyTheme)

    applyThemeToDocument(dom.window.document, resolved.light, "light", "first")
    applyThemeToDocument(dom.window.document, resolved.light, "light", "second")

    expect(events).toEqual(["first", "second"])
    expect(dom.window.document.documentElement.dataset.theme).toBe("second")
    expect(getAppliedTheme(dom.window.document)?.tokens).toBe(resolved.light)
    expect(dom.window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      resolveThemeColor(resolved.light, "background-stronger"),
    )
    expect(dom.window.document.querySelectorAll("#synergy-theme")).toHaveLength(1)
  })

  test("resolves CSS variable references before writing browser theme color", () => {
    dom = new JSDOM('<!doctype html><html><head><meta name="theme-color"></head><body></body></html>')
    const resolved = resolveTheme({
      ...synergyTheme,
      light: {
        ...synergyTheme.light,
        overrides: {
          ...synergyTheme.light.overrides,
          "background-stronger": "var(--surface-raised-base)",
        },
      },
    }).light

    applyThemeToDocument(dom.window.document, resolved, "light", "reference-background")

    expect(dom.window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      resolveThemeColor(resolved, "background-stronger"),
    )
  })
})

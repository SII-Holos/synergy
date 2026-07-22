import { describe, expect, test } from "bun:test"
import { synergyHighlightTheme } from "@ericsanchezok/synergy-ui/context/marked"
import {
  resolveTheme,
  resolveThemeColor,
  synergyTheme,
  THEME_CHANGE_EVENT,
  type ThemeChangeDetail,
} from "@ericsanchezok/synergy-ui/theme"
import { mermaidThemeVariables, subscribeMermaidThemeChanges } from "../../../src/components/note/extensions"
import { registerSynergyShikiThemes } from "../../../src/components/note/shiki-theme"

function themeDetail(mode: "light" | "dark"): ThemeChangeDetail {
  return { mode, themeId: synergyTheme.id, tokens: resolveTheme(synergyTheme)[mode] }
}

describe("Note theme adapters", () => {
  test("Shiki syntax colors are CSS-variable references that update without rebuilding the editor", () => {
    const serialized = JSON.stringify(synergyHighlightTheme)
    expect(serialized).toContain("var(--syntax-keyword)")
    expect(serialized).toContain("var(--syntax-diff-add)")
    expect(serialized).not.toContain("github-light")
    expect(serialized).not.toContain("github-dark")
    const colors = [...serialized.matchAll(/"foreground":"([^"]+)"/g)].map((match) => match[1])
    expect(colors.length).toBeGreaterThan(10)
    expect(colors.every((color) => color.startsWith("var(--"))).toBe(true)
  })

  test("the Note editor registers both custom Shiki variants instead of bundled GitHub themes", async () => {
    const shiki = await import("shiki")
    registerSynergyShikiThemes()
    const themes = shiki.bundledThemes as Record<string, () => Promise<{ default: { name: string; type: string } }>>
    const light = await themes["synergy-light"]?.()
    const dark = await themes["synergy-dark"]?.()
    expect(light?.default).toMatchObject({ name: "synergy-light", type: "light" })
    expect(dark?.default).toMatchObject({ name: "synergy-dark", type: "dark" })
  })

  test("Mermaid base theme maps nodes, text, borders, lines, notes and chart series to resolved tokens", () => {
    const detail = themeDetail("dark")
    const variables = mermaidThemeVariables(detail)
    const color = (token: Parameters<typeof resolveThemeColor>[1]) => resolveThemeColor(detail.tokens, token)
    expect(variables.darkMode).toBe(true)
    expect(variables.primaryTextColor).toBe(color("text-base"))
    expect(variables.primaryBorderColor).toBe(color("border-interactive-base"))
    expect(variables.lineColor).toBe(color("icon-weak-base"))
    expect(variables.clusterBkg).toBe(color("surface-inset-base"))
    expect(variables.noteBkgColor).toBe(color("surface-warning-weak"))
    expect((variables as Record<string, unknown>).pie1).toBe(color("chart-series-1"))
    expect((variables as Record<string, unknown>).pie9).toBe(color("chart-series-9"))
  })

  test("Mermaid views rerender on the unified theme event and unsubscribe on destroy", () => {
    const target = new EventTarget()
    const seen: ThemeChangeDetail[] = []
    const unsubscribe = subscribeMermaidThemeChanges(target, (detail) => seen.push(detail))
    const detail = themeDetail("light")
    target.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail }))
    unsubscribe()
    target.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: themeDetail("dark") }))
    expect(seen).toEqual([detail])
  })
})

import { describe, expect, test } from "bun:test"
import { DEFAULT_IDENTITY_TEXT } from "../../src/boss/boss-prompt"
import { BASE_REPORT_STYLE, renderBossPersona } from "../../src/boss/persona"

/**
 * Deterministic persona rendering contract (R2 / R7): same input always
 * yields the same identity + report-style text; presets, custom traits, the
 * legacy identity fallback, and the boss name each render without LLM calls.
 */
describe("renderBossPersona", () => {
  test("no persona and no legacy text falls back to the neutral colleague default", () => {
    const rendered = renderBossPersona({})
    expect(rendered.identityText).toBe(DEFAULT_IDENTITY_TEXT)
    expect(rendered.reportStyle).toContain(BASE_REPORT_STYLE)
    expect(rendered.reportStyle).toContain("channel_push")
  })

  test("legacy identity text is used only when no persona preset is configured", () => {
    const rendered = renderBossPersona({ legacyIdentityText: "LEGACY_COLLEAGUE" })
    expect(rendered.identityText).toContain("LEGACY_COLLEAGUE")
    expect(rendered.identityText).not.toContain(DEFAULT_IDENTITY_TEXT)
  })

  test("blank legacy text falls back to the default identity", () => {
    const rendered = renderBossPersona({ legacyIdentityText: "   " })
    expect(rendered.identityText).toBe(DEFAULT_IDENTITY_TEXT)
  })

  test("project_manager preset renders its character and reporting directives", () => {
    const rendered = renderBossPersona({ persona: { preset: "project_manager" } })
    expect(rendered.identityText).toContain("项目经理")
    expect(rendered.identityText).toContain(DEFAULT_IDENTITY_TEXT)
    expect(rendered.reportStyle).toContain("先一句话结论并标注状态")
    expect(rendered.reportStyle).toContain("2-4 条要点")
  })

  test("ops_assistant preset renders its character and reporting directives", () => {
    const rendered = renderBossPersona({ persona: { preset: "ops_assistant" } })
    expect(rendered.identityText).toContain("运营助理")
    expect(rendered.identityText).toContain(DEFAULT_IDENTITY_TEXT)
    expect(rendered.reportStyle).toContain("2-3 个选项")
  })

  test("persona preset takes precedence over the legacy identity text", () => {
    const rendered = renderBossPersona({
      persona: { preset: "ops_assistant" },
      legacyIdentityText: "LEGACY_COLLEAGUE",
    })
    expect(rendered.identityText).toContain("运营助理")
    expect(rendered.identityText).not.toContain("LEGACY_COLLEAGUE")
  })

  test("custom persona renders per-trait directives at trait thresholds", () => {
    const rendered = renderBossPersona({
      persona: {
        preset: "custom",
        formality: 1,
        conciseness: 0,
        proactiveness: 0.5,
        warmth: 1,
      },
    })
    expect(rendered.identityText).toContain("按照用户偏好打磨风格")
    expect(rendered.reportStyle).toContain("用词正式、结构清晰")
    expect(rendered.reportStyle).toContain("适当展开背景与理由")
    expect(rendered.reportStyle).toContain("语气温暖")
    // Mid-level traits contribute no directive text.
    expect(rendered.reportStyle).not.toContain("主动指出下一步")
  })

  test("custom persona at the low end renders the relaxed trait text", () => {
    const rendered = renderBossPersona({
      persona: { preset: "custom", formality: 0, conciseness: 1, proactiveness: 1, warmth: 0 },
    })
    expect(rendered.reportStyle).toContain("语气轻松随意")
    expect(rendered.reportStyle).toContain("单条回传通常不超过五行")
    expect(rendered.reportStyle).toContain("主动指出下一步")
    expect(rendered.reportStyle).toContain("保持中立克制")
  })

  test("custom persona at the exact mid points contributes no per-trait text", () => {
    const rendered = renderBossPersona({
      persona: { preset: "custom", formality: 0.5, conciseness: 0.5, proactiveness: 0.5, warmth: 0.5 },
    })
    expect(rendered.reportStyle).toBe(BASE_REPORT_STYLE)
  })

  test("a boss name is prefixed into the identity when present", () => {
    const rendered = renderBossPersona({ name: "小飞", persona: { preset: "project_manager" } })
    expect(rendered.identityText).toContain("名字叫「小飞」")
    expect(rendered.identityText).toContain(DEFAULT_IDENTITY_TEXT)
  })

  test("whitespace-only names are omitted", () => {
    const rendered = renderBossPersona({ name: "   " })
    expect(rendered.identityText).not.toContain("名字叫")
  })

  test("rendered blocks stay bounded for extreme custom values", () => {
    const rendered = renderBossPersona({
      name: "一个特别长的名字".repeat(20),
      persona: { preset: "custom", formality: 1, conciseness: 1, proactiveness: 1, warmth: 1 },
    })
    expect(rendered.identityText.length).toBeLessThan(2_000)
    expect(rendered.reportStyle.length).toBeLessThan(2_000)
  })
})

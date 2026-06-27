import { describe, expect, test } from "bun:test"

const providersPanel = await Bun.file(new URL("./ProvidersPanel.tsx", import.meta.url)).text()
const providerFlow = await Bun.file(new URL("../../provider/ProviderConnectionFlow.tsx", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("../settings-panel.css", import.meta.url)).text()

describe("Providers panel UI contract", () => {
  test("keeps provider discovery in an internal scroll column", () => {
    expect(providersPanel).toContain("providers-directory-scroll")
    expect(settingsCss).toContain(".providers-directory-scroll")
    expect(settingsCss).toContain(".providers-detail-content")
    expect(settingsCss).toContain(".ds-content-inner:has(> .providers-workspace)")
  })

  test("does not expose advanced provider allow or deny text fields", () => {
    expect(providersPanel).not.toContain("Advanced availability")
    expect(providersPanel).not.toContain("Enabled Providers")
    expect(providersPanel).not.toContain("Disabled Providers")
    expect(providersPanel).not.toContain("SettingsFieldGrid")
  })

  test("uses explicit authorization links in provider login flows", () => {
    expect(providerFlow).toContain("Open authorization page")
    expect(providerFlow).toContain("provider-auth-link")
    expect(providerFlow).not.toContain("this link")
  })

  test("keeps usage out of provider connection details", () => {
    expect(providerFlow).not.toContain("provider.usage")
    expect(providerFlow).not.toContain("Loading usage")
    expect(providerFlow).not.toContain("UsageSummary")
    expect(settingsCss).not.toContain(".provider-flow-usage")
    expect(providerFlow).toContain("!connected() && methods().length === 1")
  })

  test("uses the curated settings recommendation set", () => {
    expect(providersPanel).toContain("SETTINGS_RECOMMENDED_PROVIDER_IDS")
    expect(providersPanel).toContain("\"deepseek\"")
    expect(providersPanel).toContain("\"openrouter\"")
    expect(providersPanel).toContain("\"openai-codex\"")
    expect(providersPanel).toContain("\"zhipu-ai-coding-plan\"")
    expect(providersPanel).toContain("filter((provider) => SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id))")
    expect(providersPanel).toContain("provider.connected && !SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id)")
    expect(providersPanel).not.toContain("isRecommendedProvider")
  })

  test("uses equal provider list and detail columns", () => {
    expect(settingsCss).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
  })

  test("pins provider status badges without stretching them", () => {
    expect(settingsCss).toContain(".providers-row > .ds-inline-badge")
    expect(settingsCss).toContain("justify-self: end")
    expect(settingsCss).toContain("width: max-content")
    expect(settingsCss).toContain("min-width: 88px")
  })

  test("does not nest a bordered connection card inside the provider detail panel", () => {
    expect(settingsCss).toContain(".providers-detail .provider-flow-body")
    expect(settingsCss).toContain("border: 0")
    expect(settingsCss).toContain("background: transparent")
  })
})

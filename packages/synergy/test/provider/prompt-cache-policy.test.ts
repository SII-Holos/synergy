import { describe, expect, test } from "bun:test"
import { PromptCachePolicy } from "../../src/provider/prompt-cache-policy"
import type { Provider } from "../../src/provider/provider"

function model(input: { providerID: string; npm: string; id?: string }): Provider.Model {
  return {
    id: `${input.providerID}/${input.id ?? "test-model"}`,
    providerID: input.providerID,
    api: {
      id: input.id ?? "test-model",
      url: "https://example.com",
      npm: input.npm,
    },
    name: input.providerID,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

describe("PromptCachePolicy", () => {
  test("routes proven OpenAI-prefix-compatible providers to late user context", () => {
    expect(PromptCachePolicy.layout(model({ providerID: "openai", npm: "@ai-sdk/openai" }))).toBe("late-user-context")
    expect(PromptCachePolicy.layout(model({ providerID: "openai-codex", npm: "@ai-sdk/openai" }))).toBe(
      "late-user-context",
    )
    expect(PromptCachePolicy.layout(model({ providerID: "azure", npm: "@ai-sdk/azure" }))).toBe("late-user-context")
    expect(PromptCachePolicy.layout(model({ providerID: "deepseek", npm: "@ai-sdk/openai-compatible" }))).toBe(
      "late-user-context",
    )
  })

  test("keeps unknown and Anthropic-style providers on system-message layout", () => {
    expect(PromptCachePolicy.layout(model({ providerID: "anthropic", npm: "@ai-sdk/anthropic" }))).toBe("system")
    expect(PromptCachePolicy.layout(model({ providerID: "custom", npm: "custom-sdk" }))).toBe("system")
  })

  test("centralizes session promptCacheKey routing separately from prompt layout", () => {
    const sessionKeyModel = model({ providerID: "openai-codex", npm: "@ai-sdk/openai" })
    const azureModel = model({ providerID: "azure", npm: "@ai-sdk/azure" })
    const compatibleModel = model({ providerID: "deepseek", npm: "@ai-sdk/openai-compatible" })

    expect(PromptCachePolicy.usesSessionPromptCacheKey(sessionKeyModel, { setCacheKey: false })).toBe(true)
    expect(PromptCachePolicy.usesSessionPromptCacheKey(azureModel)).toBe(true)
    expect(PromptCachePolicy.usesSessionPromptCacheKey(compatibleModel)).toBe(false)
    expect(PromptCachePolicy.usesSessionPromptCacheKey(compatibleModel, { setCacheKey: true })).toBe(true)
  })
})

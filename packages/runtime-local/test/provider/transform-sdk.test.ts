import { expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ProviderTransform } from "@ericsanchezok/synergy-harness/provider/transform"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"

type ModelOverrides = Omit<Partial<Provider.Model>, "capabilities"> & {
  capabilities?: Partial<Provider.Model["capabilities"]>
}

const createMockModel = (overrides: ModelOverrides = {}): Provider.Model => {
  const capabilities = {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
  return {
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    cost: {
      input: 0.001,
      output: 0.002,
      cache: { read: 0.0001, write: 0.0002 },
    },
    limit: {
      context: 128000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
    capabilities: { ...capabilities, ...overrides.capabilities },
  }
}

const anthropicModel = (apiID: string, overrides: ModelOverrides = {}): Provider.Model =>
  createMockModel({
    id: `anthropic/${apiID}`,
    providerID: "anthropic",
    api: {
      id: apiID,
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    ...overrides,
  })

test("Kimi K3 effort variants pass the locked Anthropic SDK validator", async () => {
  const model = createMockModel({
    id: "k3",
    family: "kimi-k3",
    providerID: "kimi-for-coding",
    api: {
      id: "k3",
      url: "https://api.kimi.com/coding/v1",
      npm: "@ai-sdk/anthropic",
    },
    capabilities: { reasoningEfforts: ["low", "high", "max"] },
  })

  for (const [variant, options] of Object.entries(ProviderTransform.variants(model))) {
    let requestBody: Record<string, unknown> | undefined
    const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const anthropic = createAnthropic({
      apiKey: "test",
      baseURL: "https://example.invalid",
      fetch: fetchFn,
    })

    try {
      await anthropic("k3").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 16,
        providerOptions: ProviderTransform.providerOptions(model, options),
      })
    } catch {}

    expect(requestBody, `${variant} should pass Anthropic provider-option validation`).toBeDefined()
    expect(requestBody?.output_config).toEqual(variant === "max" ? undefined : { effort: variant })
  }
})

test("adaptive variants pass the locked Anthropic SDK validator", async () => {
  const model = anthropicModel("claude-opus-4-7", { limit: { context: 200000, output: 128000 } })
  const variants = ProviderTransform.variants(model)
  for (const [variant, options] of Object.entries(variants)) {
    let requestBody: Record<string, unknown> | undefined
    const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const anthropic = createAnthropic({
      apiKey: "test",
      baseURL: "https://example.invalid",
      fetch: fetchFn,
    })

    try {
      await anthropic("claude-opus-4-7").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 16,
        providerOptions: ProviderTransform.providerOptions(model, options),
      })
    } catch {}

    expect(requestBody, `${variant} should pass Anthropic provider-option validation`).toBeDefined()
    expect(requestBody?.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(requestBody?.output_config).toEqual({ effort: variant })
  }
})

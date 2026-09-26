import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models-schemas"
import { ProviderThinking } from "../../src/provider/thinking"

function model(id: string, npm: string, options: ModelsDev.ReasoningOption[]): Provider.Model {
  return {
    id,
    providerID: "account",
    api: { id, npm, url: "https://example.invalid" },
    name: id,
    status: "active",
    capabilities: Provider.mergeModelCapabilities({ reasoning: true, reasoning_options: options }),
    options: {},
    headers: {},
    release_date: "2026-01-01",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 32000 },
  }
}

test("catalog reasoning controls retain toggle, null and budget bounds", () => {
  const options = [
    { type: "toggle" },
    { type: "effort", values: [null, "high"] },
    { type: "budget", min: 0, max: 24576 },
  ]
  expect(ModelsDev.ReasoningOption.array().parse(options)).toEqual(options)
  expect(Provider.mergeModelCapabilities({ reasoning: true, reasoning_options: options }).reasoningOptions).toEqual(
    options,
  )
  expect(ModelsDev.reasoningEfforts({ reasoning_options: [{ type: "effort", values: [null] }] })).toEqual([])
})

test("automatic budget choices stay inside the declared range", () => {
  const gemini = model("gemini-2.5-flash", "@ai-sdk/google", [{ type: "budget", min: 128, max: 8192 }])
  expect(ProviderTransform.variants(gemini)).toEqual({
    high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
    max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
  })
})

test("Off is a concrete capability of a model and its transport", () => {
  expect(
    ProviderThinking.offOptions(model("deepseek-v4-flash", "@ai-sdk/openai-compatible", [{ type: "toggle" }])),
  ).toEqual({ thinking: { type: "disabled" } })
  expect(
    ProviderThinking.offOptions(model("deepseek-v4-flash", "@ai-sdk/anthropic", [{ type: "toggle" }])),
  ).toBeUndefined()
  expect(
    ProviderThinking.offOptions(
      model("gemini-2.5-flash", "@ai-sdk/google", [{ type: "toggle" }, { type: "budget", min: 0, max: 24576 }]),
    ),
  ).toEqual({ thinkingConfig: { thinkingBudget: 0, includeThoughts: false } })
  expect(
    ProviderThinking.offOptions(model("gemini-2.5-pro", "@ai-sdk/google", [{ type: "budget", min: 128, max: 32768 }])),
  ).toBeUndefined()
  expect(
    ProviderThinking.offOptions(
      model("gpt-5.4", "@ai-sdk/openai", [{ type: "effort", values: [null, "low", "high"] }]),
    ),
  ).toEqual({ reasoningEffort: "none" })
  expect(
    ProviderThinking.offOptions(
      model("claude-opus-4-7", "@ai-sdk/anthropic", [{ type: "effort", values: ["high", "max"] }]),
    ),
  ).toBeUndefined()
})

test("DeepSeek enabled efforts and Off generate different wire options", () => {
  const deepseek = model("deepseek-v4-flash", "@ai-sdk/openai-compatible", [
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ])
  expect(ProviderTransform.variants(deepseek)).toEqual({
    low: { reasoningEffort: "low", thinking: { type: "enabled" } },
    high: { reasoningEffort: "high", thinking: { type: "enabled" } },
    max: { reasoningEffort: "max", thinking: { type: "enabled" } },
    off: { thinking: { type: "disabled" } },
  })
})

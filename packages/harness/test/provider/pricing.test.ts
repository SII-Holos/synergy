import { expect, test } from "bun:test"
import { ProviderPricing } from "../../src/provider/pricing"
import { RolloutUsage } from "../../src/session/rollout/usage"
import { ModelsDevCatalog } from "../../src/provider/models-schemas"

test("accepts the pinned external catalog while keeping explicit pricing strict", async () => {
  const catalog = ModelsDevCatalog.parse(
    await Bun.file(new URL("../../../testing/fixtures/models-api.json", import.meta.url)).json(),
  )
  expect(catalog.openai.models["gpt-5.4"].cost).toBeDefined()
  expect(ProviderPricing.Cost.safeParse({ input: 1, misspelled: 2 }).success).toBe(false)
  const price = ProviderPricing.resolve({
    providerID: "openai",
    modelID: "gpt-5.4",
    cost: catalog.openai.models["gpt-5.4"].cost,
    source: "catalog",
  })
  const usage = (input: number) =>
    RolloutUsage.normalize("openai", {
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 100,
    })
  expect(ProviderPricing.estimate(price, usage(250_000), "openai").total).toBe(0.6265)
  expect(ProviderPricing.estimate(price, usage(300_000), "openai").total).toBe(1.50225)
})

test("accepts external tier extensions without relaxing configured pricing", () => {
  const cost = {
    input: 1,
    output: 2,
    tiers: [{ tier: { type: "context", size: 200_000 }, input: 3, input_audio: 4, reasoning: 5, future_rate: 6 }],
    context_over_200k: { input: 3, input_audio: 4 },
  }
  const parsed = ProviderPricing.CatalogCost.parse(cost)
  const price = ProviderPricing.resolve({ providerID: "fixture", modelID: "fixture", cost: parsed, source: "catalog" })
  expect(price?.raw).toEqual(cost)
  expect(price?.contextTiers?.[0].rates.input).toBe(3)
  expect(ProviderPricing.Cost.safeParse(cost).success).toBe(false)
  expect(
    ProviderPricing.CatalogCost.safeParse({ tiers: [{ tier: { type: "context", size: 1 }, input: -1 }] }).success,
  ).toBe(false)
})

test("prices OpenAI output once, including its reasoning subset", () => {
  const pricing = ProviderPricing.resolve({
    providerID: "openai",
    modelID: "test",
    cost: { input: 3, output: 15, cache_read: 1 },
    source: "catalog",
  })
  const usage = RolloutUsage.normalize("openai", {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 500,
    output_tokens_details: { reasoning_tokens: 100 },
  })
  const cost = ProviderPricing.estimate(pricing, usage, "openai")
  expect(cost.total).toBe(0.0105)
  expect(cost.known).toBe(0.0105)
  expect(cost.missing).toEqual([])
})

test("missing cache prices and absent model prices remain unknown", () => {
  const pricing = ProviderPricing.resolve({
    providerID: "openai",
    modelID: "test",
    cost: { input: 3, output: 15 },
    source: "catalog",
  })
  const usage = RolloutUsage.normalize("openai", {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens: 500,
  })
  expect(ProviderPricing.estimate(pricing, usage, "openai")).toMatchObject({
    total: null,
    known: 0.0099,
    missing: ["cacheRead.price"],
  })
  expect(ProviderPricing.resolve({ providerID: "test", modelID: "missing", source: "catalog" })).toBeNull()
})

test("subscription equivalent is distinct from actual account charges", () => {
  const usage = RolloutUsage.normalize("openai", null)
  const estimate = ProviderPricing.estimate(null, usage, "openai-codex")
  expect(estimate.total).toBeNull()
  expect(estimate.basis).toBe("subscription_api_equivalent")
})

test("uses distinct cache TTL rates and never substitutes a generic write rate for unknown duration", () => {
  const pricing = ProviderPricing.resolve({
    providerID: "anthropic",
    modelID: "test",
    source: "configuration",
    cost: { input: 3, output: 15, cache_write: 4, cache_write_1h: 6 },
  })
  const raw = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 30 }
  const usage = RolloutUsage.normalize("anthropic", {
    ...raw,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  })
  expect(ProviderPricing.estimate(pricing, usage, "anthropic").total).toBe(0.00121)
  expect(ProviderPricing.estimate(pricing, RolloutUsage.normalize("anthropic", raw), "anthropic").total).toBeNull()
})

test("audio duration has an explicit unit and does not require fictional token counts", () => {
  const usage = RolloutUsage.normalize("openai", { type: "duration", seconds: 30 }, "transcription")
  expect(ProviderPricing.estimate(null, usage, "voice")).toMatchObject({
    total: null,
    missing: ["audio_seconds.price"],
  })
  const pricing = ProviderPricing.resolve({
    providerID: "voice",
    modelID: "test",
    source: "configuration",
    cost: { units: { audio_seconds: { price: 0.006, per: 60 } } },
  })
  expect(ProviderPricing.estimate(pricing, usage, "voice").total).toBe(0.003)
})

test("cached audio with unknown modality overlap is not charged twice in the known subtotal", () => {
  const pricing = ProviderPricing.resolve({
    providerID: "openai",
    modelID: "test",
    source: "configuration",
    cost: { input: 3, output: 15, cache_read: 1, units: { audio_input_tokens: { price: 32, per: 1_000_000 } } },
  })
  const usage = RolloutUsage.normalize("openai", {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 400, audio_tokens: 500 },
    output_tokens: 100,
  })
  const estimate = ProviderPricing.estimate(pricing, usage, "openai")
  expect(estimate.total).toBeNull()
  expect(estimate.known).toBe(0.0015)
  expect(estimate.missing).toContain("audio_input_tokens.cache_overlap")
})

test("nonstandard service tiers do not masquerade as known standard API spend", () => {
  const usage = { ...RolloutUsage.normalize("openai", { input_tokens: 10, output_tokens: 5 }), serviceTier: "flex" }
  const price = ProviderPricing.resolve({
    providerID: "openai",
    modelID: "test",
    source: "configuration",
    cost: { input: 1, output: 2 },
  })
  expect(ProviderPricing.estimate(price, usage, "openai")).toMatchObject({
    total: null,
    known: 0,
    missing: ["service_tier.flex.price"],
  })
})

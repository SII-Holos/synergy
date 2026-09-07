import { expect, test } from "bun:test"
import { RolloutUsage } from "../../src/session/rollout/usage"

test("OpenAI output includes reasoning and separates cached input", () => {
  const usage = RolloutUsage.normalize("openai", {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens: 500,
    output_tokens_details: { reasoning_tokens: 100 },
  })
  expect(usage.input).toEqual({ total: 1000, uncached: 800, cacheRead: 200, cacheWrite: 0 })
  expect(usage.output).toEqual({ total: 500, reasoning: 100 })
  expect(usage.complete).toBe(true)
})

test("missing and invalid usage stays unknown rather than becoming free usage", () => {
  const usage = RolloutUsage.normalize("openai", { prompt_tokens: 1000, completion_tokens: -5 })
  expect(usage.input.total).toBe(1000)
  expect(usage.input.uncached).toBeNull()
  expect(usage.input.cacheRead).toBeNull()
  expect(usage.output.total).toBeNull()
  expect(usage.complete).toBe(false)
})

test("Anthropic and Google use their distinct input and output semantics", () => {
  const anthropic = RolloutUsage.normalize("anthropic", {
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
    output_tokens: 50,
  })
  expect(anthropic.input.total).toBe(600)
  const google = RolloutUsage.normalize("google", {
    promptTokenCount: 1000,
    cachedContentTokenCount: 200,
    candidatesTokenCount: 400,
    thoughtsTokenCount: 100,
  })
  expect(google.output.total).toBe(500)
  expect(google.input.uncached).toBe(800)
})

test("inconsistent provider totals do not produce a complete accounting record", () => {
  const usage = RolloutUsage.normalize("openai", {
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 90,
    completion_tokens: 10,
  })
  expect(usage.complete).toBe(false)
  expect(usage.input.uncached).toBeNull()
})

test("preserves cache-write categories and duration billing independently of token totals", () => {
  const usage = RolloutUsage.normalize("anthropic", {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  })
  expect(usage.cacheWrites).toEqual({ ephemeral_5m: 10, ephemeral_1h: 20 })
  const audio = RolloutUsage.normalize("openai", { type: "duration", seconds: 12.5 }, "transcription")
  expect(audio.units).toEqual([{ unit: "audio_seconds", quantity: 12.5 }])
  expect(audio.input.total).toBeNull()
  expect(audio.billing).toBe("units")
  const embedding = RolloutUsage.normalize("openai", { prompt_tokens: 8, total_tokens: 8 }, "embedding")
  expect(embedding.input.uncached).toBe(8)
  expect(embedding.output.total).toBe(0)
})

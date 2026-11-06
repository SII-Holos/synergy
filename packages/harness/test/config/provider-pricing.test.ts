import { expect, test } from "bun:test"
import { Provider } from "../../src/config/schema"

test("configured model pricing preserves legacy fields while rejecting unknown tier rates", () => {
  for (const cost of [
    { context_over_200k: { input: 1, misspelled: 2 } },
    { tiers: [{ tier: { type: "context" as const, size: 100 }, input: 1, misspelled: 2 }] },
  ]) {
    expect(Provider.safeParse({ models: { test: { cost } } }).success).toBe(false)
  }
  expect(Provider.safeParse({ models: { test: { cost: { input: 1, input_audio: 2, future_rate: 3 } } } }).success).toBe(
    true,
  )
  const cost = {
    input: 1,
    output: 2,
    tiers: [{ tier: { type: "context" as const, size: 100 }, input: 3 }],
    units: { audio_input_tokens: { price: 4, per: 1_000_000 } },
  }
  expect(Provider.parse({ models: { test: { cost } } }).models?.test.cost).toEqual(cost)
})

import { expect, test } from "bun:test"
import { RolloutAccounting } from "../../src/session/rollout/accounting"
import { RolloutUsage } from "../../src/session/rollout/usage"
import { ProviderPricing } from "../../src/provider/pricing"

const pricing = ProviderPricing.resolve({
  providerID: "deepseek",
  modelID: "deepseek-flash",
  source: "configuration",
  cost: { input: 0.15, cache_read: 0.003, output: 0.6 },
})

function summarize(mode: "api" | "unknown" | "subscription" | "local", reported?: number) {
  const usage = RolloutUsage.normalize("openai", {
    prompt_tokens: 1_304_156,
    prompt_cache_miss_tokens: 184_029,
    prompt_cache_hit_tokens: 1_120_127,
    completion_tokens: 23_369,
    completion_tokens_details: { reasoning_tokens: 12_432 },
  })
  if (reported !== undefined) usage.reported = { amount: reported, currency: "USD", source: "fixture" }
  const call: RolloutAccounting.CallInput = {
    id: "call",
    runID: "run",
    execution: mode === "local" ? "local" : "provider",
    model: { providerID: "deepseek", modelID: "deepseek-flash", sdk: "@ai-sdk/openai", pricing, billingMode: mode },
    sdkUsage: null,
    kind: "chat",
  }
  return RolloutAccounting.summarize({
    calls: [call],
    attempts:
      mode === "local"
        ? []
        : [
            {
              id: "paid",
              callID: call.id,
              runID: call.runID,
              usage,
              estimate: ProviderPricing.estimate(pricing, usage, mode),
            },
            { id: "missing", callID: call.id, runID: call.runID },
          ],
    gaps: [],
  })
}

test("unclassified API evidence preserves a positive known estimate and the missing attempt", () => {
  const result = summarize("unknown")
  expect(result.apiEstimate.known).toBe(0)
  expect(result.unclassifiedEquivalent.known).toBeCloseTo(0.044986131, 12)
  expect(result.costCoverage?.unclassified.attempts).toBe(2)
  expect(result.costCoverage?.unclassified.unreported).toEqual({ known: 0.044986131, unknown: 1, total: null })
  expect(result.tokens.output.known).toBe(23_369)
  expect(result.tokens.total.known).toBe(1_327_525)
})

test("reported charges exclude the same attempt from unreported estimates", () => {
  const result = summarize("api", 0.05)
  expect(result.reported.currencies).toEqual({ USD: 0.05 })
  expect(result.apiEstimate.known).toBeCloseTo(0.044986131, 12)
  expect(result.costCoverage?.api.unreported).toEqual({ known: 0, unknown: 1, total: null })
  expect(RolloutAccounting.merge([result, result]).costCoverage?.api.attempts).toBe(4)
})

test("local execution and subscription equivalence retain their commercial distinction", () => {
  expect(summarize("local").costCoverage?.local).toBe(1)
  const subscription = summarize("subscription")
  expect(subscription.costCoverage?.api.attempts).toBe(0)
  expect(subscription.costCoverage?.subscription.unreported.known).toBeCloseTo(0.044986131, 12)
})

test("older accounting summaries without coverage remain explicitly historical", () => {
  const old = summarize("unknown")
  delete old.costCoverage
  const result = RolloutAccounting.merge([old])
  expect(result.unclassifiedEquivalent.known).toBeCloseTo(0.044986131, 12)
  expect(result.costCoverage?.historical).toBe(2)
  expect(RolloutAccounting.knownExpense(result)).toBeCloseTo(0.044986131, 12)
})

test("merging legacy amounts preserves their value and does not count missing records twice", () => {
  const old = RolloutAccounting.empty()
  delete old.costCoverage
  old.legacy = { cost: 0.12, messages: 1 }
  old.attempts = 1
  old.apiEstimate = { known: 0.03, total: 0.03, unknown: 0 }
  const result = RolloutAccounting.merge([old])
  expect(result.costCoverage?.historical).toBe(1)
  expect(RolloutAccounting.knownExpense(result)).toBeCloseTo(0.15, 12)
})

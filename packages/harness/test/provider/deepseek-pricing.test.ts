import { expect, test } from "bun:test"
import { ProviderPricing } from "../../src/provider/pricing"
import { ProviderBilling } from "../../src/provider/billing"
import { RolloutUsage } from "../../src/session/rollout/usage"

const catalog = ProviderPricing.resolve({
  providerID: "deepseek",
  modelID: "deepseek-flash",
  source: "catalog",
  cost: { input: 0.15, cache_read: 0.003, output: 0.6 },
})!
const usage = RolloutUsage.normalize("openai", {
  prompt_tokens: 1000,
  prompt_cache_hit_tokens: 400,
  prompt_cache_miss_tokens: 600,
  completion_tokens: 500,
  completion_tokens_details: { reasoning_tokens: 200 },
})
const capture = (time: string, endpoint = "https://api.deepseek.com/chat/completions") =>
  ProviderPricing.capture(catalog, endpoint, Date.parse(time))
test("official billing requires a declared origin while explicit custom contracts still win", () => {
  const input = { profile: "api" as const, origins: ["https://api.deepseek.com"], endpoint: "https://proxy.test/v1" }
  expect(ProviderBilling.resolve(input)).toBe("unknown")
  expect(ProviderBilling.resolve({ ...input, endpoint: "https://api.deepseek.com/v1" })).toBe("api")
  expect(ProviderBilling.resolve({ ...input, connection: "subscription" })).toBe("subscription")
})
test("official rates use UTC windows, holidays, cache usage and output including reasoning", () => {
  const off = capture("2026-10-08T00:59:59Z")
  const peak = capture("2026-10-08T01:00:00Z")
  expect(off?.policy?.phase).toBe("off-peak")
  expect(peak?.policy?.phase).toBe("peak")
  expect(ProviderPricing.estimate(off, usage, "api").total).toBeCloseTo(0.0003912, 10)
  expect(ProviderPricing.estimate(peak, usage, "api").total).toBeCloseTo(0.0007824, 10)
  expect(capture("2026-10-01T02:00:00Z")?.policy?.phase).toBe("off-peak")
  expect(capture("2026-10-10T02:00:00Z")?.policy?.phase).toBe("off-peak")
})
test("price boundary or unavailable holiday calendar yields a range rather than an exact bill", () => {
  const price = capture("2026-10-08T00:59:59Z")
  expect(ProviderPricing.estimate(price, usage, "api", Date.parse("2026-10-08T01:00:02Z"))).toMatchObject({
    range: { minimum: 0.0003912, maximum: 0.0007824 },
  })
  expect(ProviderPricing.estimate(capture("2027-02-01T02:00:00Z"), usage, "api").range).toBeDefined()
  expect(capture("2026-10-08T02:00:00Z", "https://proxy.test/v1")).toBe(catalog)
  const configured = { ...catalog, source: { ...catalog.source, kind: "configuration" as const } }
  expect(ProviderPricing.capture(configured, "https://api.deepseek.com", Date.now())).toBe(configured)
})

test("the verified official weekday schedule covers both peak windows and their gaps", () => {
  for (const [time, phase] of [
    ["00:59:59", "off-peak"],
    ["01:00:00", "peak"],
    ["03:59:59", "peak"],
    ["04:00:00", "off-peak"],
    ["05:59:59", "off-peak"],
    ["06:00:00", "peak"],
    ["09:59:59", "peak"],
    ["10:00:00", "off-peak"],
    ["16:00:00", "off-peak"],
  ] as const)
    expect(capture(`2026-10-08T${time}Z`)?.policy?.phase).toBe(phase)
  expect(
    ProviderPricing.estimate(capture("2026-10-08T03:59:59Z"), usage, "api", Date.parse("2026-10-08T04:00:00Z")).range,
  ).toBeDefined()
  expect(
    ProviderPricing.estimate(capture("2026-10-08T00:59:59Z"), usage, "api", Date.parse("2026-10-08T04:00:00Z")).range,
  ).toBeDefined()
})

import { expect, test } from "bun:test"
import { ProviderBilling } from "../../src/provider/billing"
import { ProviderPricing } from "../../src/provider/pricing"
import { Provider } from "../../src/config/schema"

test("explicit local billing has no API charge even without a price catalog", () => {
  expect(ProviderPricing.estimate(null, undefined, "local")).toMatchObject({
    basis: "local",
    known: 0,
    total: 0,
    missing: [],
  })
})

test("billing classification uses explicit model, connection and profile metadata in that order", () => {
  expect(ProviderBilling.resolve({ model: "api", connection: "subscription", profile: "local" })).toBe("api")
  expect(ProviderBilling.resolve({ connection: "subscription", profile: "api" })).toBe("subscription")
  expect(ProviderBilling.resolve({ profile: "local" })).toBe("local")
  expect(ProviderBilling.resolve({})).toBe("unknown")
  expect(Provider.parse({ billingMode: "subscription", models: { m: { billingMode: "api" } } })).toMatchObject({
    billingMode: "subscription",
    models: { m: { billingMode: "api" } },
  })
  expect(ProviderPricing.estimate(null, undefined, "unknown").basis).toBe("unclassified_api_equivalent")
  expect(ProviderPricing.estimate(null, undefined, "subscription").basis).toBe("subscription_api_equivalent")
})

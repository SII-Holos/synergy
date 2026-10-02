import { expect, test } from "bun:test"
import { executionMoney, executionCostText } from "../../../src/components/execution/cost"
const cost = {
  state: "partial" as const,
  reported: [],
  estimates: [
    { basis: "unclassified" as const, currency: "USD" as const, known: 0.044986131, maximum: 0.044986131, unknown: 1 },
  ],
  equivalent: null,
  missing: 1,
  historical: 0,
  knownUSD: 0.044986131,
}
test("positive amounts do not round to a zero fee", () => {
  expect(executionMoney(0.044986131, "USD", "en")).toBe("US$0.045")
  expect(executionMoney(0.000001, "USD", "en")).toBe("< US$0.0001")
  expect(executionMoney(0, "USD", "en")).toBe("US$0.00")
})
test("known subtotal, separate currencies and unknown records remain distinct", () => {
  expect(executionCostText(cost, "en")).toBe("≥ ≈ US$0.045")
  expect(
    executionCostText(
      {
        ...cost,
        state: "mixed",
        missing: 0,
        reported: [
          { currency: "EUR", amount: 2 },
          { currency: "USD", amount: 1 },
        ],
      },
      "en",
    ),
  ).toContain("EUR 2.00")
  expect(executionCostText({ ...cost, state: "unknown", knownUSD: 0, estimates: [] }, "en")).toBe("—")
})

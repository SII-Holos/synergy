import { expect, test } from "bun:test"
import { accountedCost, formatCost } from "../../../src/components/stats/format"
import { formatBytes } from "../../../src/components/performance/chart-model"

test("known zero and small nonzero costs remain distinguishable", () => {
  expect(formatCost(0)).toBe("$0.00")
  expect(formatCost(0.000001)).toBe("$0.000001")
  expect(formatCost(1.25)).toBe("$1.25")
})

test("byte values use binary units without changing unknown or zero values", () => {
  expect(formatBytes(undefined)).toBe("—")
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(939062)).toBe("917.1 KiB")
  expect(formatBytes(1024 ** 2)).toBe("1 MiB")
  expect(formatBytes(1024 ** 3)).toBe("1 GiB")
})

test("unpriced calls do not turn into a known zero cost", () => {
  expect(accountedCost(0, { apiEstimate: { known: 0, unknown: 2 }, legacy: { cost: 0, messages: 0 } })).toBeUndefined()
  expect(accountedCost(0, { apiEstimate: { known: 0, unknown: 0 }, legacy: { cost: 0, messages: 0 } })).toBe(0)
  expect(
    accountedCost(0.000001, { apiEstimate: { known: 0.000001, unknown: 2 }, legacy: { cost: 0, messages: 0 } }),
  ).toBe(0.000001)
  expect(accountedCost(0)).toBe(0)
})

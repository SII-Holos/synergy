import { describe, expect, test } from "bun:test"
import { performancePollInterval } from "./use-performance"

describe("performance live polling", () => {
  test("uses fast fallback polling while SSE is disconnected", () => {
    expect(performancePollInterval(false)).toBe(10_000)
  })

  test("slows polling after SSE connects", () => {
    expect(performancePollInterval(true)).toBe(30_000)
  })
})

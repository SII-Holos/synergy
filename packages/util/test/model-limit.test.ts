import { describe, expect, test } from "bun:test"
import { ModelLimit } from "../src/model-limit"

const usage = (overrides: Partial<ModelLimit.TokenUsage> = {}): ModelLimit.TokenUsage => ({
  input: 100,
  output: 50,
  reasoning: 10,
  cache: { read: 200, write: 300 },
  ...overrides,
})

describe("ModelLimit.actualInput", () => {
  test("sums reported input with cache reads and writes", () => {
    expect(ModelLimit.actualInput(usage())).toBe(600)
  })

  test("reports plain input when no cache tokens were consumed", () => {
    expect(ModelLimit.actualInput(usage({ cache: { read: 0, write: 0 } }))).toBe(100)
  })
})

describe("ModelLimit.usableInput", () => {
  test("returns the full context window when no explicit input limit exists", () => {
    expect(ModelLimit.usableInput({ context: 128_000 })).toBe(128_000)
    expect(ModelLimit.usableInput({ context: 128_000, input: 0 })).toBe(128_000)
  })

  test("uses an explicit positive input limit when provided", () => {
    expect(ModelLimit.usableInput({ context: 128_000, input: 64_000 })).toBe(64_000)
  })

  test("returns zero for missing, zero-context, or nonpositive limits", () => {
    expect(ModelLimit.usableInput()).toBe(0)
    expect(ModelLimit.usableInput({ context: 0 })).toBe(0)
    expect(ModelLimit.usableInput({ context: 128_000, input: -1 })).toBe(128_000)
  })
})

describe("ModelLimit constants", () => {
  test("output headroom is smaller than the absolute output cap", () => {
    expect(ModelLimit.OUTPUT_TOKEN_HEADROOM).toBeLessThan(ModelLimit.OUTPUT_TOKEN_MAX)
  })
})

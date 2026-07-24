import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"

describe("ExperienceEncoder stream bounds", () => {
  test("learning defaults expose encoder timeout and output bounds", () => {
    expect(Config.LEARNING_DEFAULTS.encoderTimeoutMs).toBe(60_000)
    expect(Config.LEARNING_DEFAULTS.encoderMaxOutputChars).toBe(16_000)
  })
})

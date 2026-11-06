import * as LibraryConfigSchema from "@ericsanchezok/synergy-library/config-schema"
import { describe, expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"

describe("ExperienceEncoder stream bounds", () => {
  test("learning defaults expose encoder timeout and output bounds", () => {
    expect(LibraryConfigSchema.LEARNING_DEFAULTS.encoderTimeoutMs).toBe(60_000)
    expect(LibraryConfigSchema.LEARNING_DEFAULTS.encoderMaxOutputChars).toBe(16_000)
  })
})

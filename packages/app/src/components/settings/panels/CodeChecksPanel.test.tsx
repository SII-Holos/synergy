import { describe, expect, test } from "bun:test"
import { codeChecksControlsDisabled } from "./code-checks-model"

describe("CodeChecksPanel", () => {
  test("disables severity and scope when post-write diagnostics are off", () => {
    expect(codeChecksControlsDisabled("false")).toBe(true)
  })

  test("keeps severity and scope enabled when post-write diagnostics are on", () => {
    expect(codeChecksControlsDisabled("true")).toBe(false)
  })
})

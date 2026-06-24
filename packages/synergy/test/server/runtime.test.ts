import { describe, expect, test } from "bun:test"
import { startupScopeLabel } from "../../src/server/runtime"

describe("server runtime startup output", () => {
  test("startup scope label does not require an Instance context", () => {
    expect(() => startupScopeLabel()).not.toThrow()
    expect(startupScopeLabel()).toBeTruthy()
  })
})

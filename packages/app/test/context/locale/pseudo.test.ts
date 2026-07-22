import { describe, expect, test } from "bun:test"
import { shouldUsePseudoLocale } from "../../../src/context/locale/pseudo"

describe("development pseudo locale", () => {
  test("activates only for the explicit development query parameter", () => {
    expect(shouldUsePseudoLocale(true, "?pseudoLocale=1")).toBe(true)
    expect(shouldUsePseudoLocale(true, "?pseudoLocale=0")).toBe(false)
    expect(shouldUsePseudoLocale(true, "")).toBe(false)
  })

  test("never activates in production", () => {
    expect(shouldUsePseudoLocale(false, "?pseudoLocale=1")).toBe(false)
  })
})

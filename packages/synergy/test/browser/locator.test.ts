import { describe, test, expect } from "bun:test"
import z from "zod"
import { BrowserLocator } from "../../src/browser/locator"

const { LocatorInputSchema, validateLocator, checkActionable } = BrowserLocator

interface ResolvedElement {
  visible: boolean
  enabled: boolean
  editable: boolean
  x: number
  y: number
  width: number
  height: number
}

describe("BrowserLocator", () => {
  // ── Locator schema validation ──────────────────────────────────

  test("validates ref locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "ref", value: "@e1" })
    expect(r.success).toBe(true)
  })

  test("validates css selector locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "css", value: "button" })
    expect(r.success).toBe(true)
  })

  test("validates role locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "role", value: "button" })
    expect(r.success).toBe(true)
  })

  test("validates role with name", () => {
    const r = LocatorInputSchema.safeParse({ kind: "role", value: "button", name: "Submit" })
    expect(r.success).toBe(true)
  })

  test("validates role with regex name", () => {
    const r = LocatorInputSchema.safeParse({ kind: "role", value: "button", name: { regex: "submit", flags: "i" } })
    expect(r.success).toBe(true)
  })

  test("validates text locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "text", value: "Hello" })
    expect(r.success).toBe(true)
  })

  test("validates label locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "label", value: "Email" })
    expect(r.success).toBe(true)
  })

  test("validates placeholder locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "placeholder", value: "Search" })
    expect(r.success).toBe(true)
  })

  test("validates testId locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "testId", value: "submit-btn" })
    expect(r.success).toBe(true)
  })

  test("validates xpath locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "xpath", value: "//button" })
    expect(r.success).toBe(true)
  })

  test("rejects unknown locator kind", () => {
    const r = LocatorInputSchema.safeParse({ kind: "unknown", value: "x" })
    expect(r.success).toBe(false)
  })

  test("rejects missing value", () => {
    const r = LocatorInputSchema.safeParse({ kind: "ref" })
    expect(r.success).toBe(false)
  })

  // ── Regex support ──────────────────────────────────────────────

  test("accepts JSON regex pattern for text locator", () => {
    const r = LocatorInputSchema.safeParse({ kind: "text", value: { regex: "hello", flags: "i" } })
    expect(r.success).toBe(true)
  })

  test("accepts JSON regex pattern for role name", () => {
    const r = LocatorInputSchema.safeParse({ kind: "role", value: "textbox", name: { regex: "search", flags: "i" } })
    expect(r.success).toBe(true)
  })

  test("rejects invalid JSON regex flags", () => {
    const duplicate = LocatorInputSchema.safeParse({ kind: "text", value: { regex: "hello", flags: "ii" } })
    const incompatible = LocatorInputSchema.safeParse({ kind: "text", value: { regex: "hello", flags: "uv" } })

    expect(duplicate.success).toBe(false)
    expect(incompatible.success).toBe(false)
  })

  test("rejects live RegExp values because tool input must be JSON-safe", () => {
    const r = LocatorInputSchema.safeParse({ kind: "text", value: /hello/i })
    expect(r.success).toBe(false)
  })

  test("converts locator schema to JSON Schema", () => {
    expect(() => z.toJSONSchema(LocatorInputSchema)).not.toThrow()
  })

  // ── validateLocator ────────────────────────────────────────────

  test("validateLocator returns ok for valid ref", () => {
    const r = validateLocator({ kind: "ref", value: "@e1" })
    expect(r.ok).toBe(true)
  })

  test("validateLocator returns not ok for invalid", () => {
    const r = validateLocator({ kind: "unknown", value: "x" })
    expect(r.ok).toBe(false)
    expect(r.message).toBeTruthy()
  })

  // ── Actionability check ────────────────────────────────────────

  function visibleElement(overrides: Partial<ResolvedElement> = {}): ResolvedElement {
    return { visible: true, enabled: true, editable: false, x: 100, y: 100, width: 50, height: 20, ...overrides }
  }

  test("checkActionable returns visible:false when not visible", () => {
    const r = checkActionable(visibleElement({ visible: false }))
    expect(r.actionable).toBe(false)
    expect(r.failures).toContain("visible")
  })

  test("checkActionable returns enabled:false when disabled", () => {
    const r = checkActionable(visibleElement({ enabled: false }))
    expect(r.actionable).toBe(false)
    expect(r.failures).toContain("enabled")
  })

  test("checkActionable returns editable:false for non-input", () => {
    const r = checkActionable(visibleElement())
    expect(r.editable).toBe(false)
    expect(r.actionable).toBe(true)
  })

  test("checkActionable passes for visible+enabled+editable", () => {
    const r = checkActionable(visibleElement({ editable: true }))
    expect(r.actionable).toBe(true)
    expect(r.failures).toHaveLength(0)
  })
})

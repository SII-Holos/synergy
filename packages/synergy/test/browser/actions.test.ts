import { describe, test, expect } from "bun:test"
import { BrowserActions, validateAction, requiredParams, ActionNames } from "../../src/browser/actions"

const { ActionInputSchema } = BrowserActions

// --- helpers ---

/** A minimal valid "ref" locator reused across tests. */
const loc = { kind: "ref" as const, value: "@e1" }

/** Assert a Zod parse succeeds and return the data. */
function ok<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, v: unknown): T {
  const r = schema.safeParse(v)
  if (!r.success) throw new Error(`expected parse to succeed: ${JSON.stringify(r.error)}`)
  return r.data!
}

/** Assert a Zod parse fails. */
function fails(schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): void {
  const r = schema.safeParse(v)
  if (r.success) throw new Error(`expected parse to fail for: ${JSON.stringify(v)}`)
}

describe("BrowserActions", () => {
  // ════════════════════════════════════════════════════════════════
  //  Action name validation
  // ════════════════════════════════════════════════════════════════

  describe("action names", () => {
    test("ActionNames is a readonly array of known actions", () => {
      expect(Array.isArray(ActionNames)).toBe(true)
      expect(ActionNames.length).toBeGreaterThanOrEqual(10)
    })

    for (const name of [
      "click",
      "dblclick",
      "press",
      "fill",
      "selectOption",
      "check",
      "uncheck",
      "hover",
      "type",
      "scroll",
    ]) {
      test(`"${name}" is a valid action name`, () => {
        expect(ActionNames as readonly string[]).toContain(name)
      })
    }

    test("rejects unknown action name", () => {
      fails(ActionInputSchema, { action: "dragAndDrop", locator: loc })
    })

    test("rejects missing action field", () => {
      fails(ActionInputSchema, { locator: loc })
    })

    test("rejects empty action string", () => {
      fails(ActionInputSchema, { action: "", locator: loc })
    })
  })

  // ════════════════════════════════════════════════════════════════
  //  Parameter validation — per-action required params
  // ════════════════════════════════════════════════════════════════

  describe("parameter validation", () => {
    // ── click ─────────────────────────────────────────────────────
    test("click: locator is required", () => {
      ok(ActionInputSchema, { action: "click", locator: loc })
    })
    test("click: missing locator → fail", () => {
      fails(ActionInputSchema, { action: "click" })
    })

    // ── dblclick ──────────────────────────────────────────────────
    test("dblclick: locator is required", () => {
      ok(ActionInputSchema, { action: "dblclick", locator: loc })
    })
    test("dblclick: missing locator → fail", () => {
      fails(ActionInputSchema, { action: "dblclick" })
    })

    // ── press ─────────────────────────────────────────────────────
    test("press: key is required", () => {
      ok(ActionInputSchema, { action: "press", key: "Enter" })
    })
    test("press: missing key → fail", () => {
      fails(ActionInputSchema, { action: "press" })
    })
    test("press: empty key → fail", () => {
      fails(ActionInputSchema, { action: "press", key: "" })
    })
    test("press: accepts modifiers array", () => {
      ok(ActionInputSchema, {
        action: "press",
        key: "a",
        modifiers: ["Control", "Shift"],
      })
    })
    test("press: rejects unknown modifier", () => {
      fails(ActionInputSchema, {
        action: "press",
        key: "a",
        modifiers: ["Hyper"],
      })
    })

    // ── fill ──────────────────────────────────────────────────────
    test("fill: locator and value are required", () => {
      ok(ActionInputSchema, { action: "fill", locator: loc, value: "hello" })
    })
    test("fill: missing value → fail", () => {
      fails(ActionInputSchema, { action: "fill", locator: loc })
    })
    test("fill: empty value is allowed (clears field)", () => {
      ok(ActionInputSchema, { action: "fill", locator: loc, value: "" })
    })
    test("fill: missing locator → fail", () => {
      fails(ActionInputSchema, { action: "fill", value: "hello" })
    })

    // ── selectOption ─────────────────────────────────────────────
    test("selectOption: locator and values are required", () => {
      ok(ActionInputSchema, {
        action: "selectOption",
        locator: loc,
        values: ["red", "blue"],
      })
    })
    test("selectOption: missing values → fail", () => {
      fails(ActionInputSchema, { action: "selectOption", locator: loc })
    })
    test("selectOption: empty values array → fail", () => {
      fails(ActionInputSchema, {
        action: "selectOption",
        locator: loc,
        values: [],
      })
    })

    // ── check ─────────────────────────────────────────────────────
    test("check: locator is required", () => {
      ok(ActionInputSchema, { action: "check", locator: loc })
    })
    test("check: missing locator → fail", () => {
      fails(ActionInputSchema, { action: "check" })
    })

    // ── uncheck ───────────────────────────────────────────────────
    test("uncheck: locator is required", () => {
      ok(ActionInputSchema, { action: "uncheck", locator: loc })
    })
    test("uncheck: missing locator → fail", () => {
      fails(ActionInputSchema, { action: "uncheck" })
    })

    // ── hover ─────────────────────────────────────────────────────
    test("hover: locator is required", () => {
      ok(ActionInputSchema, { action: "hover", locator: loc })
    })

    // ── type ──────────────────────────────────────────────────────
    test("type: locator and text are required", () => {
      ok(ActionInputSchema, { action: "type", locator: loc, text: "hello" })
    })
    test("type: missing text → fail", () => {
      fails(ActionInputSchema, { action: "type", locator: loc })
    })
    test("type: empty text → fail", () => {
      fails(ActionInputSchema, { action: "type", locator: loc, text: "" })
    })

    // ── scroll ────────────────────────────────────────────────────
    test("scroll: no params needed (defaults)", () => {
      ok(ActionInputSchema, { action: "scroll" })
    })
    test("scroll: accepts x/y", () => {
      ok(ActionInputSchema, { action: "scroll", x: 100, y: 200 })
    })
    test("scroll: x and y can be zero", () => {
      ok(ActionInputSchema, { action: "scroll", x: 0, y: 0 })
    })
    test("scroll: x and y can be negative", () => {
      ok(ActionInputSchema, { action: "scroll", x: -100, y: -50 })
    })
  })

  // ════════════════════════════════════════════════════════════════
  //  validateAction
  // ════════════════════════════════════════════════════════════════

  describe("validateAction", () => {
    test("returns ok for valid click", () => {
      const r = validateAction({ action: "click", locator: loc })
      expect(r.ok).toBe(true)
    })

    test("returns ok for valid press", () => {
      const r = validateAction({ action: "press", key: "Enter" })
      expect(r.ok).toBe(true)
    })

    test("returns ok for valid fill", () => {
      const r = validateAction({ action: "fill", locator: loc, value: "hello" })
      expect(r.ok).toBe(true)
    })

    test("returns not ok for invalid action name", () => {
      const r = validateAction({ action: "bogus" })
      expect(r.ok).toBe(false)
      expect(r.message).toBeTruthy()
    })

    test("returns not ok for missing required param", () => {
      const r = validateAction({ action: "fill", locator: loc })
      expect(r.ok).toBe(false)
      expect(r.message).toContain("value")
    })
  })

  //  requiredParams — action → required param names
  // ════════════════════════════════════════════════════════════════

  describe("requiredParams", () => {
    test("click requires locator", () => {
      expect(requiredParams("click")).toEqual(["locator"])
    })

    test("dblclick requires locator", () => {
      expect(requiredParams("dblclick")).toEqual(["locator"])
    })

    test("press requires key", () => {
      expect(requiredParams("press")).toEqual(["key"])
    })

    test("fill requires locator, value", () => {
      expect(requiredParams("fill")).toEqual(["locator", "value"])
    })

    test("selectOption requires locator, values", () => {
      expect(requiredParams("selectOption")).toEqual(["locator", "values"])
    })

    test("check requires locator", () => {
      expect(requiredParams("check")).toEqual(["locator"])
    })

    test("uncheck requires locator", () => {
      expect(requiredParams("uncheck")).toEqual(["locator"])
    })

    test("hover requires locator", () => {
      expect(requiredParams("hover")).toEqual(["locator"])
    })

    test("type requires locator, text", () => {
      expect(requiredParams("type")).toEqual(["locator", "text"])
    })

    test("scroll requires nothing", () => {
      expect(requiredParams("scroll")).toEqual([])
    })

    test("unknown action returns empty array", () => {
      expect(requiredParams("nonexistent")).toEqual([])
    })
  })

  // ════════════════════════════════════════════════════════════════
  //  Edge cases
  // ════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    test("action name is case-sensitive", () => {
      fails(ActionInputSchema, { action: "Click", locator: loc })
    })

    test("extra unknown fields are not rejected (forward-compat)", () => {
      ok(ActionInputSchema, { action: "click", locator: loc, futureField: 42 })
    })

    test("BrowserActions.resolveAndRun is exported", () => {
      expect(typeof (BrowserActions as Record<string, unknown>).resolveAndRun).toBe("function")
    })

    test("BrowserActions.run is exported", () => {
      expect(typeof (BrowserActions as Record<string, unknown>).run).toBe("function")
    })
  })
})

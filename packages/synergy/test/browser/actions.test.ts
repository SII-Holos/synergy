import { describe, test, expect } from "bun:test"
import {
  BrowserActions,
  validateAction,
  buildCdpCommands,
  requiredParams,
  ActionNames,
} from "../../src/browser/actions"

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
        expect(ActionNames).toContain(name)
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

  // ════════════════════════════════════════════════════════════════
  //  CDP command shape generation
  // ════════════════════════════════════════════════════════════════

  describe("buildCdpCommands", () => {
    // ── click → mousePressed + mouseReleased ──────────────────────
    test("click produces mousePressed and mouseReleased", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "click", locator: loc }))
      expect(cmds).toHaveLength(2)
      expect(cmds[0]).toMatchObject({ method: "Input.dispatchMouseEvent" })
      expect(cmds[1]).toMatchObject({ method: "Input.dispatchMouseEvent" })
      expect((cmds[0].params as Record<string, unknown>).type).toBe("mousePressed")
      expect((cmds[1].params as Record<string, unknown>).type).toBe("mouseReleased")
    })

    test("click commands carry x, y, button", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "click", locator: loc }))
      for (const cmd of cmds) {
        const p = cmd.params as Record<string, unknown>
        expect(typeof p.x).toBe("number")
        expect(typeof p.y).toBe("number")
        expect(p.button).toBe("left")
      }
    })

    test("click commands use button if provided", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "click", locator: loc, button: "right" }))
      for (const cmd of cmds) {
        expect((cmd.params as Record<string, unknown>).button).toBe("right")
      }
    })

    // ── dblclick → 2 × (mousePressed + mouseReleased) ─────────────
    test("dblclick produces 4 commands", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "dblclick", locator: loc }))
      expect(cmds).toHaveLength(4)
      expect(cmds[0].params).toHaveProperty("type", "mousePressed")
      expect(cmds[1].params).toHaveProperty("type", "mouseReleased")
      expect(cmds[2].params).toHaveProperty("type", "mousePressed")
      expect(cmds[3].params).toHaveProperty("type", "mouseReleased")
    })

    test("dblclick clickCount is 2 on press events", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "dblclick", locator: loc }))
      expect((cmds[0].params as Record<string, unknown>).clickCount).toBe(2)
      expect((cmds[2].params as Record<string, unknown>).clickCount).toBe(2)
    })

    // ── press → dispatchKeyEvent ─────────────────────────────────
    test("press produces a keyDown event", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "press", key: "Enter" }))
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ method: "Input.dispatchKeyEvent" })
      expect((cmds[0].params as Record<string, unknown>).type).toBe("keyDown")
    })

    test("press key is mapped via virtual key code", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "press", key: "a" }))
      const p = cmds[0].params as Record<string, unknown>
      expect(p.key).toBe("a")
      expect(typeof p.windowsVirtualKeyCode).toBe("number")
    })

    test("press with modifiers sends modifier flags", () => {
      const cmds = buildCdpCommands(
        ok(ActionInputSchema, {
          action: "press",
          key: "c",
          modifiers: ["Control"],
        }),
      )
      const p = cmds[0].params as Record<string, unknown>
      expect(p.modifiers).toBeGreaterThan(0)
    })

    // ── fill → focus + selectAll + insertText ────────────────────
    test("fill produces focus + selectAll + insertText sequence", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "fill", locator: loc, value: "hello" }))
      expect(cmds.length).toBeGreaterThanOrEqual(3)
      const methods = cmds.map((c) => c.method)
      expect(methods).toContain("Runtime.evaluate")
      expect(methods).toContain("Input.insertText")
    })

    test("fill insertText carries the value as text", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "fill", locator: loc, value: "hello" }))
      const insert = cmds.find((c) => c.method === "Input.insertText")
      expect(insert).toBeDefined()
      expect((insert!.params as Record<string, unknown>).text).toBe("hello")
    })

    test("fill empty value produces insertText with empty text", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "fill", locator: loc, value: "" }))
      const insert = cmds.find((c) => c.method === "Input.insertText")
      expect(insert).toBeDefined()
      expect((insert!.params as Record<string, unknown>).text).toBe("")
    })

    // ── selectOption → dispatch select commands ──────────────────
    test("selectOption produces DOM manipulation commands", () => {
      const cmds = buildCdpCommands(
        ok(ActionInputSchema, {
          action: "selectOption",
          locator: loc,
          values: ["red"],
        }),
      )
      expect(cmds.length).toBeGreaterThan(0)
      // At minimum a Runtime.evaluate to manipulate the select
      expect(cmds.some((c) => c.method === "Runtime.evaluate")).toBe(true)
    })

    test("selectOption with multiple values", () => {
      const cmds = buildCdpCommands(
        ok(ActionInputSchema, {
          action: "selectOption",
          locator: loc,
          values: ["red", "blue"],
        }),
      )
      expect(cmds.length).toBeGreaterThan(0)
    })

    // ── check / uncheck ─────────────────────────────────────────
    test("check produces Runtime.evaluate to set checked", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "check", locator: loc }))
      expect(cmds).toHaveLength(1)
      expect(cmds[0].method).toBe("Runtime.evaluate")
    })

    test("uncheck produces Runtime.evaluate to unset checked", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "uncheck", locator: loc }))
      expect(cmds).toHaveLength(1)
      expect(cmds[0].method).toBe("Runtime.evaluate")
    })

    // ── hover → mouseMoved ───────────────────────────────────────
    test("hover produces a mouseMoved event", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "hover", locator: loc }))
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ method: "Input.dispatchMouseEvent" })
      expect((cmds[0].params as Record<string, unknown>).type).toBe("mouseMoved")
    })

    // ── type → keyDown + keyUp per character ─────────────────────
    test("type produces keyDown+keyUp pair per character", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "type", locator: loc, text: "ab" }))
      // 2 chars × 2 events each = 4 + optional focus prefix
      expect(cmds.length).toBeGreaterThanOrEqual(4)
      const keyEvents = cmds.filter((c) => c.method === "Input.dispatchKeyEvent")
      expect(keyEvents.length).toBeGreaterThanOrEqual(4)
      const types = keyEvents.map((c) => (c.params as Record<string, unknown>).type)
      expect(types.filter((t) => t === "keyDown")).toHaveLength(2)
      expect(types.filter((t) => t === "keyUp")).toHaveLength(2)
    })

    test("type carries individual character keys", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "type", locator: loc, text: "ab" }))
      const keyEvents = cmds.filter((c) => c.method === "Input.dispatchKeyEvent")
      const keys = keyEvents.map((c) => (c.params as Record<string, unknown>).key)
      expect(keys).toContain("a")
      expect(keys).toContain("b")
    })

    // ── scroll → mouseWheel ──────────────────────────────────────
    test("scroll produces mouseWheel event", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "scroll", x: 0, y: 100 }))
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).toMatchObject({ method: "Input.dispatchMouseEvent" })
      expect((cmds[0].params as Record<string, unknown>).type).toBe("mouseWheel")
    })

    test("scroll defaults delta to zero", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "scroll" }))
      const p = cmds[0].params as Record<string, unknown>
      expect(p.deltaX).toBe(0)
      expect(p.deltaY).toBe(0)
    })

    test("scroll passes delta values", () => {
      const cmds = buildCdpCommands(ok(ActionInputSchema, { action: "scroll", x: 50, y: -200 }))
      const p = cmds[0].params as Record<string, unknown>
      expect(p.deltaX).toBe(50)
      expect(p.deltaY).toBe(-200)
    })
  })

  // ════════════════════════════════════════════════════════════════
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

    test("buildCdpCommands returns copy, not reference", () => {
      const action = ok(ActionInputSchema, { action: "click", locator: loc })
      const a = buildCdpCommands(action)
      const b = buildCdpCommands(action)
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })

    test("buildCdpCommands accepts validated action", () => {
      const action = ok(ActionInputSchema, { action: "click", locator: loc })
      const cmds = buildCdpCommands(action)
      expect(Array.isArray(cmds)).toBe(true)
      // Every command must have method and params
      for (const cmd of cmds) {
        expect(typeof cmd.method).toBe("string")
        expect(typeof cmd.params).toBe("object")
        expect(cmd.params).not.toBeNull()
      }
    })
  })
})

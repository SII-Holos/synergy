import { describe, expect, test } from "bun:test"
import { BrowserEval } from "../../src/browser/eval.js"

describe("BrowserEval", () => {
  describe("buildReadonlyEval", () => {
    test("preserves expression and sets throwOnSideEffect", () => {
      const result = BrowserEval.buildReadonlyEval("document.title")
      expect(result.expression).toBe("document.title")
      expect(result.throwOnSideEffect).toBe(true)
    })
  })

  describe("buildTrustedEval", () => {
    test("returns just the expression", () => {
      const result = BrowserEval.buildTrustedEval("window.close()")
      expect(result).toEqual({ expression: "window.close()" })
    })
  })

  describe("sanitizeEvalResult", () => {
    test("stringifies primitives", () => {
      expect(BrowserEval.sanitizeEvalResult("hello")).toBe('"hello"')
      expect(BrowserEval.sanitizeEvalResult(42)).toBe("42")
      expect(BrowserEval.sanitizeEvalResult(true)).toBe("true")
      expect(BrowserEval.sanitizeEvalResult(null)).toBe("null")
      expect(BrowserEval.sanitizeEvalResult(undefined)).toBe("null")
    })

    test("stringifies objects", () => {
      expect(BrowserEval.sanitizeEvalResult({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}')
    })

    test("stringifies arrays", () => {
      expect(BrowserEval.sanitizeEvalResult([1, 2, 3])).toBe("[1,2,3]")
    })

    test("handles NaN and Infinity", () => {
      expect(BrowserEval.sanitizeEvalResult(NaN)).toBe("null")
      expect(BrowserEval.sanitizeEvalResult(Infinity)).toBe("null")
    })

    test("handles functions and symbols", () => {
      expect(BrowserEval.sanitizeEvalResult(() => {})).toBe("null")
      expect(BrowserEval.sanitizeEvalResult(Symbol("test"))).toBe("null")
    })

    test("handles bigint", () => {
      expect(BrowserEval.sanitizeEvalResult(123n)).toBe('"123n"')
    })

    test("detects circular references", () => {
      const circ: Record<string, unknown> = {}
      circ.self = circ
      const result = BrowserEval.sanitizeEvalResult(circ)
      expect(result).toContain("<circular>")
    })

    test("truncates at maxBytes", () => {
      const result = BrowserEval.sanitizeEvalResult("x".repeat(100), 5)
      expect(result).toContain("[truncated]")
    })

    test("returns stringified bare object when JSON would fail", () => {
      // RegExp returns empty object in JSON but our serializer handles it
      const result = BrowserEval.sanitizeEvalResult(/test/)
      // Should produce valid JSON-like output or fallback string
      expect(typeof result).toBe("string")
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("isEvalAllowed", () => {
    test("allows readonly by default", () => {
      expect(BrowserEval.isEvalAllowed("readonly", "any-scope")).toBe(true)
    })

    test("denies trusted by default", () => {
      expect(BrowserEval.isEvalAllowed("trusted", "any-scope")).toBe(false)
    })
  })
})

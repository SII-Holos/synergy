import { BrowserClipboard } from "../../src/browser/clipboard"
import { describe, test, expect } from "bun:test"

describe("BrowserClipboard", () => {
  // buildReadClipboardExpr
  test("buildReadClipboardExpr returns a self-invoking async IIFE", () => {
    const expr = BrowserClipboard.buildReadClipboardExpr()
    expect(expr).toContain("navigator.clipboard.readText")
    expect(expr).toContain("async")
    expect(expr).toContain("catch")
  })

  // buildWriteClipboardExpr
  test("buildWriteClipboardExpr embeds escaped text", () => {
    const expr = BrowserClipboard.buildWriteClipboardExpr('hello "world"')
    expect(expr).toContain("navigator.clipboard.writeText")
    expect(expr).toContain('hello \\"world\\"')
  })

  test("buildWriteClipboardExpr handles empty string", () => {
    const expr = BrowserClipboard.buildWriteClipboardExpr("")
    expect(expr).toContain('""')
  })

  // buildGrantClipboardPermExpr
  test("buildGrantClipboardPermExpr returns an async IIFE", () => {
    const expr = BrowserClipboard.buildGrantClipboardPermExpr()
    expect(expr).toContain("navigator.clipboard.readText")
    expect(expr).toContain("async")
    expect(expr).toContain("catch")
  })

  // sanitizeClipboardText
  test("sanitizeClipboardText passes through clean text", () => {
    expect(BrowserClipboard.sanitizeClipboardText("hello")).toBe("hello")
  })

  test("sanitizeClipboardText strips null bytes", () => {
    expect(BrowserClipboard.sanitizeClipboardText("he\0llo")).toBe("hello")
    expect(BrowserClipboard.sanitizeClipboardText("\0\0")).toBe("")
  })

  test("sanitizeClipboardText handles empty string", () => {
    expect(BrowserClipboard.sanitizeClipboardText("")).toBe("")
  })

  test("sanitizeClipboardText truncates to maxBytes", () => {
    const bigText = "a".repeat(200)
    const truncated = BrowserClipboard.sanitizeClipboardText(bigText, 100)
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(100)
    expect(truncated.length).toBeLessThan(bigText.length)
  })

  test("sanitizeClipboardText respects multi-byte boundaries", () => {
    const multiByte = "你好世界" // 4 chars, 12 bytes (each CJK char = 3 bytes in UTF-8)
    const truncated = BrowserClipboard.sanitizeClipboardText(multiByte, 6)
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(6)
    // Should keep at most 2 characters (6 bytes)
    expect(truncated.length).toBeLessThan(multiByte.length)
  })

  test("sanitizeClipboardText uses default 1MB limit when not specified", () => {
    const text = "hello"
    expect(BrowserClipboard.sanitizeClipboardText(text)).toBe("hello")
  })

  // ClipboardResult type
  test("ClipboardResult type is structurally sound", () => {
    const result: BrowserClipboard.ClipboardResult = { text: "hello", ok: true }
    expect(result.text).toBe("hello")
    expect(result.ok).toBe(true)

    const failResult: BrowserClipboard.ClipboardResult = { text: null, ok: false }
    expect(failResult.text).toBeNull()
    expect(failResult.ok).toBe(false)
  })
})

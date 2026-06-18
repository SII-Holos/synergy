import { describe, expect, test } from "bun:test"
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  computeFileHash,
} from "../../src/hashline/index"

// ============================================================================
// detectLineEnding
// ============================================================================
describe("detectLineEnding", () => {
  test("detects CRLF when first newline is \\r\\n", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n")
  })

  test("detects LF when first newline is \\n", () => {
    expect(detectLineEnding("a\nb\r\nc")).toBe("\n")
  })

  test("returns LF for text without any newlines", () => {
    expect(detectLineEnding("no newlines")).toBe("\n")
  })

  test("returns LF for empty string", () => {
    expect(detectLineEnding("")).toBe("\n")
  })
})

// ============================================================================
// normalizeToLF
// ============================================================================
describe("normalizeToLF", () => {
  test("converts all CRLF to LF", () => {
    expect(normalizeToLF("a\r\nb\r\nc")).toBe("a\nb\nc")
  })

  test("leaves LF-only text unchanged", () => {
    const text = "a\nb\n"
    expect(normalizeToLF(text)).toBe(text)
  })

  test("handles mixed line endings", () => {
    expect(normalizeToLF("a\r\nb\nc\r\nd")).toBe("a\nb\nc\nd")
  })

  test("handles lone CR", () => {
    expect(normalizeToLF("a\rb")).toBe("a\nb")
  })
})

// ============================================================================
// restoreLineEndings
// ============================================================================
describe("restoreLineEndings", () => {
  test("restores CRLF", () => {
    expect(restoreLineEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc")
  })

  test("passes through LF", () => {
    expect(restoreLineEndings("a\nb\nc", "\n")).toBe("a\nb\nc")
  })
})

// ============================================================================
// stripBom
// ============================================================================
describe("stripBom", () => {
  test("strips UTF-8 BOM", () => {
    const result = stripBom("\uFEFFhello")
    expect(result.bom).toBe("\uFEFF")
    expect(result.text).toBe("hello")
  })

  test("returns empty bom for non-BOM text", () => {
    const result = stripBom("hello")
    expect(result.bom).toBe("")
    expect(result.text).toBe("hello")
  })

  test("handles empty string", () => {
    const result = stripBom("")
    expect(result.bom).toBe("")
    expect(result.text).toBe("")
  })
})

// ============================================================================
// computeFileHash
// ============================================================================
describe("computeFileHash", () => {
  test("produces 4-char uppercase hex", () => {
    const hash = computeFileHash("hello\n")
    expect(hash).toMatch(/^[0-9A-F]{4}$/)
  })

  test("same content → same hash", () => {
    const h1 = computeFileHash("content")
    const h2 = computeFileHash("content")
    expect(h1).toBe(h2)
  })

  test("different content → different hash", () => {
    const h1 = computeFileHash("hello world aaa")
    const h2 = computeFileHash("hello world bbb")
    expect(h1).not.toBe(h2)
  })

  test("trailing whitespace stripped before hashing", () => {
    const h1 = computeFileHash("a\nb\n")
    const h2 = computeFileHash("a  \nb  \n")
    expect(h1).toBe(h2)
  })
})

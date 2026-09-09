import { describe, expect, test } from "bun:test"
import { computeTag, normalizeContent } from "../../src/hashline/tag"

describe("hashline tag computation", () => {
  describe("computeTag", () => {
    test("produces 4-char uppercase hex for simple content", () => {
      const tag = computeTag("hello world\n")
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("is deterministic for same content", () => {
      const content = "function foo() {\n  return 1\n}\n"
      const tag1 = computeTag(content)
      const tag2 = computeTag(content)
      expect(tag1).toBe(tag2)
    })

    test("differs for different content", () => {
      const tag1 = computeTag("hello\n")
      const tag2 = computeTag("world\n")
      expect(tag1).not.toBe(tag2)
    })

    test("same tag for content with different line endings", () => {
      const unixContent = "line1\nline2\nline3\n"
      const windowsContent = "line1\r\nline2\r\nline3\r\n"
      expect(computeTag(unixContent)).toBe(computeTag(windowsContent))
    })

    test("handles empty content", () => {
      const tag = computeTag("")
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("handles single line content", () => {
      const tag = computeTag("single line")
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("handles unicode content", () => {
      const tag = computeTag("こんにちは\n世界\n")
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("handles large content without throwing", () => {
      const largeContent = "x".repeat(100000) + "\n"
      const tag = computeTag(largeContent)
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("produces consistent tags across multiple calls", () => {
      const content = "const x = 1\nexport default x\n"
      const results = new Set(Array.from({ length: 100 }, () => computeTag(content)))
      expect(results.size).toBe(1)
    })
  })

  describe("normalizeContent", () => {
    test("converts CRLF to LF", () => {
      expect(normalizeContent("a\r\nb\r\nc")).toBe("a\nb\nc")
    })

    test("keeps LF-only content unchanged", () => {
      const content = "a\nb\nc\n"
      expect(normalizeContent(content)).toBe(content)
    })

    test("handles mixed line endings by converting all CRLF to LF", () => {
      const result = normalizeContent("a\r\nb\nc\r\nd")
      expect(result).toBe("a\nb\nc\nd")
    })

    test("handles empty string", () => {
      expect(normalizeContent("")).toBe("")
    })
  })
})

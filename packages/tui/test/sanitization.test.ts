import { describe, expect, test } from "bun:test"
import { sanitizeTerminalText, sanitizeTerminalLine, sanitizeTerminalLabel } from "../src/sanitization"

describe("terminal text sanitization", () => {
  test("strips ANSI CSI and SGR sequences", () => {
    expect(sanitizeTerminalText("safe\u001b[31mred\u001b[0m text")).toBe("safered text")
    expect(sanitizeTerminalText("x\u009b2Jy")).toBe("xy")
  })

  test("strips OSC, DCS, APC, PM, and SOS payloads", () => {
    expect(sanitizeTerminalText("a\u001b]0;owned\u0007b")).toBe("ab")
    expect(sanitizeTerminalText("a\u001bPpayload\u001b\\b")).toBe("ab")
    expect(sanitizeTerminalText("a\u001b_payload\u001b\\b")).toBe("ab")
    expect(sanitizeTerminalText("a\u001b^payload\u001b\\b")).toBe("ab")
    expect(sanitizeTerminalText("a\u001bXpayload\u001b\\b")).toBe("ab")
  })

  test("strips terminal controls while preserving newlines and tabs", () => {
    expect(sanitizeTerminalText("a\u0000\u0007\u0008\r\u007fb\n\tc")).toBe("ab\n\tc")
  })

  test("preserves CJK, emoji, ZWJ sequences, and markdown", () => {
    const input = "# 标题\n你好，日本語，한글 👋🏽 🧑‍💻\n```ts\nconst ok = true\n```"
    expect(sanitizeTerminalText(input)).toBe(input)
  })

  test("strips bidirectional formatting controls without breaking emoji joins", () => {
    expect(sanitizeTerminalText("safe\u202Eexe.txt\u202C name\u2066isolated\u2069")).toBe("safeexe.txt nameisolated")
    expect(sanitizeTerminalText("left\u200Eright\u200F arabic\u061Cmark")).toBe("leftright arabicmark")
    expect(sanitizeTerminalText("🧑‍💻")).toBe("🧑‍💻")
  })

  test("does not leak truncated escape payloads", () => {
    expect(sanitizeTerminalText("before\u001b]0;unfinished")).toBe("before")
    expect(sanitizeTerminalText("before\u001b[31")).toBe("before")
  })

  test("creates a safe single-line label", () => {
    expect(sanitizeTerminalLine(" first\nsecond\tthird \u001b[31m ")).toBe("first second third")
  })

  test("uses a visible fallback when sanitization removes an entire label", () => {
    expect(sanitizeTerminalLabel("\u001b[31m\u001b[0m", "unnamed")).toBe("unnamed")
    expect(sanitizeTerminalLabel(" visible ", "unnamed")).toBe("visible")
  })
})

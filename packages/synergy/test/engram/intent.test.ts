import { describe, expect, test } from "bun:test"
import { Intent } from "@/engram/intent"

describe("Intent.sanitize", () => {
  test("returns cleaned intent for valid output", () => {
    expect(Intent.sanitize("Fix broken auth middleware after refactoring", "fallback")).toBe(
      "Fix broken auth middleware after refactoring",
    )
  })

  test("strips XML tags", () => {
    expect(Intent.sanitize("<intent>Fix authentication middleware</intent>", "fallback")).toBe(
      "Fix authentication middleware",
    )
  })

  test("returns fallback for junk output", () => {
    expect(Intent.sanitize("n/a", "fallback")).toBe("fallback")
    expect(Intent.sanitize("---", "fallback")).toBe("fallback")
    expect(Intent.sanitize("???", "fallback")).toBe("fallback")
  })

  test("returns fallback for too-short output", () => {
    expect(Intent.sanitize("hi", "fallback")).toBe("fallback")
  })

  test("returns fallback when model hallucinates tool calls", () => {
    expect(Intent.sanitize("[Tool: bash] Check working tree status", "fallback")).toBe("fallback")
    expect(Intent.sanitize("[Tool: dagwrite] Create plan", "fallback")).toBe("fallback")
  })

  test("returns fallback when output contains tool hallucination among other text", () => {
    expect(Intent.sanitize("[Tool: bash] Run tests\nAll tests passed", "fallback")).toBe("fallback")
  })

  test("preserves normal text that mentions tools in prose", () => {
    expect(Intent.sanitize("Use the bash tool to run tests after refactoring", "fallback")).toBe(
      "Use the bash tool to run tests after refactoring",
    )
  })
})

describe("Intent.isValid", () => {
  test("valid for normal intent", () => {
    expect(Intent.isValid("Fix broken auth middleware after refactoring")).toBe(true)
  })

  test("invalid for junk", () => {
    expect(Intent.isValid("n/a")).toBe(false)
    expect(Intent.isValid("??")).toBe(false)
  })

  test("invalid for tool hallucination", () => {
    expect(Intent.isValid("[Tool: bash] Check status")).toBe(false)
  })

  test("valid for text mentioning tools in prose", () => {
    expect(Intent.isValid("Use the bash tool to check status")).toBe(true)
  })
})

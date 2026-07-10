import { describe, expect, test } from "bun:test"
import { Script } from "@/library/script"

describe("Script.sanitize", () => {
  test("returns valid script unchanged", () => {
    const script =
      "1. Read auth middleware tests\n2. Identify the broken fixture import path\n3. Fix the import and run the suite"
    expect(Script.sanitize(script, "fallback")).toBe(script)
  })

  test("returns fallback for junk output", () => {
    expect(Script.sanitize("n/a", "fallback")).toBe("fallback")
    expect(Script.sanitize("", "fallback")).toBe("fallback")
    expect(Script.sanitize("???", "fallback")).toBe("fallback")
  })

  test("returns fallback for too-short output", () => {
    expect(Script.sanitize("hi", "fallback")).toBe("fallback")
  })

  test("returns fallback when model hallucinates tool calls", () => {
    expect(Script.sanitize("[Tool: bash] Check working tree status", "fallback")).toBe("fallback")
  })

  test("returns fallback for Chinese assistant reasoning", () => {
    expect(Script.sanitize("好的，我先创建一个总览 note 文件", "fallback")).toBe("fallback")
    expect(Script.sanitize("让我来分析这个问题", "fallback")).toBe("fallback")
  })

  test("returns fallback for English assistant reasoning", () => {
    expect(Script.sanitize("I see you're pointing out that the prompts need updating", "fallback")).toBe("fallback")
    expect(Script.sanitize("Your proposal looks good, go ahead", "fallback")).toBe("fallback")
  })

  test("returns fallback when output has no numbered steps", () => {
    expect(Script.sanitize("Read the file and fix the bug then run tests", "fallback")).toBe("fallback")
  })

  test("returns fallback when output has too few steps", () => {
    expect(Script.sanitize("1. Fix the bug", "fallback")).toBe("fallback")
  })

  test("script with prose mention of tools is valid", () => {
    const script =
      "1. Use the read tool to inspect the controller\n2. Fix the null check in the handler\n3. Run the type checker to verify"
    expect(Script.sanitize(script, "fallback")).toBe(script)
  })
})

describe("Script.sanitizeWithReason", () => {
  test("keeps valid script and emits ok", () => {
    expect(Script.sanitizeWithReason("1. Read auth module\n2. Fix middleware\n3. Run tests", "fallback")).toEqual({
      value: "1. Read auth module\n2. Fix middleware\n3. Run tests",
      reason: "ok",
    })
  })

  test("flags no-steps and falls back", () => {
    expect(Script.sanitizeWithReason("Read the file and fix the bug", "fallback")).toEqual({
      value: "fallback",
      reason: "no-steps",
    })
  })

  test("flags too-few-steps and falls back", () => {
    expect(Script.sanitizeWithReason("1. Fix the bug", "fallback")).toEqual({
      value: "fallback",
      reason: "too-few-steps",
    })
  })

  test("flags tool-hallucination and falls back", () => {
    expect(Script.sanitizeWithReason("[Tool: bash] Run tests", "fallback")).toEqual({
      value: "fallback",
      reason: "tool-hallucination",
    })
  })

  test("flags assistant-reasoning and falls back", () => {
    expect(Script.sanitizeWithReason("Let me inspect the code first", "fallback")).toEqual({
      value: "fallback",
      reason: "assistant-reasoning",
    })
  })

  test("flags junk and falls back", () => {
    expect(Script.sanitizeWithReason("n/a", "fallback")).toEqual({
      value: "fallback",
      reason: "junk",
    })
  })
})

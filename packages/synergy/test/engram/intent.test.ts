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

  test("invalid for oversized intent", () => {
    const longIntent = "a".repeat(301)
    expect(Intent.isValid(longIntent)).toBe(false)
  })

  test("invalid for excessive tool markers", () => {
    const toolSpam = "[Tool: read] file1 [Tool: read] file2 [Tool: read] file3"
    expect(Intent.isValid(toolSpam)).toBe(false)
  })

  test("invalid for excessive log markers", () => {
    const logSpam = "[Log] routes [Log] request [Log] response"
    expect(Intent.isValid(logSpam)).toBe(false)
  })
})

describe("Intent.sanitize truncation", () => {
  test("truncates intent exceeding max length", () => {
    const longIntent = "Fix authentication middleware and update tests and refactor utils".padEnd(400, " x")
    const result = Intent.sanitize(longIntent, "fallback")
    expect(result.length).toBeLessThanOrEqual(300)
    expect(result).not.toBe("fallback")
  })

  test("returns fallback for excessive tool output", () => {
    const toolSpam = "Start [Tool: read] a [Tool: read] b [Tool: read] c"
    expect(Intent.sanitize(toolSpam, "fallback")).toBe("fallback")
  })
})

describe("Intent.sanitize assistant reasoning", () => {
  test("returns fallback for Chinese assistant reasoning", () => {
    expect(Intent.sanitize("好的，我先创建一个总览 note 文件", "fallback")).toBe("fallback")
    expect(Intent.sanitize("让我来分析这个问题", "fallback")).toBe("fallback")
    expect(Intent.sanitize("我觉得应该从底层开始重构", "fallback")).toBe("fallback")
  })

  test("returns fallback for English assistant reasoning", () => {
    expect(Intent.sanitize("I see you're pointing out that the prompts need updating", "fallback")).toBe("fallback")
    expect(Intent.sanitize("Let me check the code first", "fallback")).toBe("fallback")
    expect(Intent.sanitize("Your proposal looks good, go ahead", "fallback")).toBe("fallback")
  })

  test("preserves normal intent that starts with a verb", () => {
    expect(Intent.sanitize("Refactor authentication middleware to use JWT tokens", "fallback")).toBe(
      "Refactor authentication middleware to use JWT tokens",
    )
    expect(Intent.sanitize("Add dark mode support to the React app", "fallback")).toBe(
      "Add dark mode support to the React app",
    )
  })
})

describe("Intent.isValid assistant reasoning", () => {
  test("invalid for Chinese assistant reasoning", () => {
    expect(Intent.isValid("好的，我先创建一个总览 note 文件")).toBe(false)
    expect(Intent.isValid("让我来分析这个问题")).toBe(false)
  })

  test("invalid for English assistant reasoning", () => {
    expect(Intent.isValid("I see you're pointing out that the prompts need updating")).toBe(false)
    expect(Intent.isValid("Your proposal looks good, go ahead")).toBe(false)
  })
})

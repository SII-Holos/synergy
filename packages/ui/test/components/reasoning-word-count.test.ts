import { describe, expect, test } from "bun:test"
import { countReasoningWords } from "../../src/components/reasoning-word-count"

describe("countReasoningWords", () => {
  test("empty, whitespace-only and punctuation-only text has no visible words", () => {
    expect(countReasoningWords([""], "en")).toBe(0)
    expect(countReasoningWords(["   \n\t  "], "en")).toBe(0)
    expect(countReasoningWords(["... !!! --- *** "], "en")).toBe(0)
    expect(countReasoningWords([], "en")).toBe(0)
  })

  test("counts one, two and three word phrases", () => {
    expect(countReasoningWords(["Thinking"], "en")).toBe(1)
    expect(countReasoningWords(["Thinking now"], "en")).toBe(2)
    expect(countReasoningWords(["We should check"], "en")).toBe(3)
  })

  test("counts natural English prose including contractions and numbers", () => {
    expect(countReasoningWords(["The quick brown fox"], "en")).toBe(4)
    expect(countReasoningWords(["don't stop"], "en")).toBe(2)
    expect(countReasoningWords(["Step 1 and 2"], "en")).toBe(4)
  })

  test("counts Chinese text by locale-sensitive word units", () => {
    expect(countReasoningWords(["你好世界"], "zh-CN")).toBe(2)
    expect(countReasoningWords(["我们需要检查证据"], "zh-CN")).toBe(4)
  })

  test("counts mixed-script text and markdown without stripping the source", () => {
    expect(countReasoningWords(["Hello 世界 world"], "en")).toBe(3)
    expect(countReasoningWords(["# Heading\ntext **bold**"], "en")).toBe(3)
    expect(countReasoningWords(["## Planning\n- First reasoning line.\n1. second"], "en")).toBe(6)
    expect(countReasoningWords(["`grep -rn` output"], "en")).toBe(3)
  })

  test("an unfinished streaming suffix counts only its finalized word segment", () => {
    expect(countReasoningWords(["Hello wor"], "en")).toBe(2)
    expect(countReasoningWords(["Hello "], "en")).toBe(1)
  })

  test("sums every canonical Part in order and never mutates the input", () => {
    const parts = ["First reasoning line", "", "Second reasoning line", "世界"]
    const snapshot = [...parts]
    expect(countReasoningWords(parts, "en")).toBe(7)
    expect(parts).toEqual(snapshot)

    const ordered = ["alpha beta", "gamma"]
    expect(countReasoningWords(ordered, "en")).toBe(3)
    expect(countReasoningWords(["gamma", "alpha beta"], "en")).toBe(3)
  })

  test("segmentation follows the requested locale", () => {
    expect(countReasoningWords(["我们需要检查证据"], "en")).toBe(4)
    expect(countReasoningWords(["我们需要检查证据"], "zh-CN")).toBe(4)
    expect(countReasoningWords(["Hello world"], "zh-CN")).toBe(2)
  })
})

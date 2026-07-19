import { describe, expect, test } from "bun:test"
import { questionOptionShortcutIndex } from "./question-prompt-model"

describe("QuestionPrompt keyboard shortcuts", () => {
  test("maps unmodified number keys to visible option indexes", () => {
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3 })).toBe(0)
    expect(questionOptionShortcutIndex({ key: "3", optionCount: 3 })).toBe(2)
  })

  test("ignores shortcuts outside the visible option range", () => {
    expect(questionOptionShortcutIndex({ key: "0", optionCount: 3 })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "4", optionCount: 3 })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "x", optionCount: 3 })).toBeUndefined()
  })

  test("ignores modified keys and editable targets", () => {
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, modified: true })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, editable: true })).toBeUndefined()
  })
})

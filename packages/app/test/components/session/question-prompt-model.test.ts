import { describe, expect, test } from "bun:test"
import { questionOptionShortcutIndex } from "../../../src/components/session/question-prompt-model"

describe("QuestionPrompt keyboard shortcuts", () => {
  test("maps unmodified number keys to visible option indexes", () => {
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, scopeActive: true })).toBe(0)
    expect(questionOptionShortcutIndex({ key: "3", optionCount: 3, scopeActive: true })).toBe(2)
  })

  test("ignores shortcuts outside the prompt interaction scope", () => {
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, scopeActive: false })).toBeUndefined()
  })

  test("ignores shortcuts outside the visible option range", () => {
    expect(questionOptionShortcutIndex({ key: "0", optionCount: 3, scopeActive: true })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "4", optionCount: 3, scopeActive: true })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "x", optionCount: 3, scopeActive: true })).toBeUndefined()
  })

  test("ignores modified keys and editable targets", () => {
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, scopeActive: true, modified: true })).toBeUndefined()
    expect(questionOptionShortcutIndex({ key: "1", optionCount: 3, scopeActive: true, editable: true })).toBeUndefined()
  })
})

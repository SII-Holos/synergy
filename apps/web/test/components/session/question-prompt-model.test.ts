import { describe, expect, test } from "bun:test"
import { questionCountdown, questionOptionShortcutIndex } from "../../../src/components/session/question-prompt-model"

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

describe("QuestionPrompt countdown window", () => {
  test("anchors the window to the server request time, not to card mount time", () => {
    const createdAt = 1_700_000_000_000
    expect(questionCountdown({ timeout: 3_600, createdAt })).toEqual({ seconds: 3_600, startedAt: createdAt })
  })

  test("renders no countdown without a server anchor, so a remount cannot invent one", () => {
    expect(questionCountdown({ timeout: 3_600 })).toBeUndefined()
    expect(questionCountdown({ timeout: 3_600, createdAt: Number.NaN })).toBeUndefined()
    expect(questionCountdown({ createdAt: 1_700_000_000_000 })).toBeUndefined()
  })

  test("treats a disabled or non-positive timeout as no window", () => {
    expect(questionCountdown({ timeout: 0, createdAt: 1_700_000_000_000 })).toBeUndefined()
    expect(questionCountdown({ timeout: -1, createdAt: 1_700_000_000_000 })).toBeUndefined()
  })
})

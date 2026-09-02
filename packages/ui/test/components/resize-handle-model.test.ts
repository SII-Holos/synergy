import { describe, expect, test } from "bun:test"
import {
  RESIZE_KEYBOARD_STEP,
  clampSeparatorSize,
  resolveSeparatorKeyboardSize,
} from "../../src/components/resize-handle-model"

const base = { size: 300, min: 220, max: 420 }

describe("resolveSeparatorKeyboardSize", () => {
  test("moves by the keyboard step and clamps into the band", () => {
    const state = { ...base, direction: "horizontal" as const }
    expect(resolveSeparatorKeyboardSize("ArrowRight", state)).toBe(300 + RESIZE_KEYBOARD_STEP)
    expect(resolveSeparatorKeyboardSize("ArrowLeft", state)).toBe(300 - RESIZE_KEYBOARD_STEP)
    expect(resolveSeparatorKeyboardSize("ArrowRight", { ...state, size: 418 })).toBe(420)
    expect(resolveSeparatorKeyboardSize("ArrowLeft", { ...state, size: 224 })).toBe(220)
  })

  test("maps vertical arrows for vertical separators", () => {
    const state = { ...base, direction: "vertical" as const }
    expect(resolveSeparatorKeyboardSize("ArrowDown", state)).toBe(300 + RESIZE_KEYBOARD_STEP)
    expect(resolveSeparatorKeyboardSize("ArrowUp", state)).toBe(300 - RESIZE_KEYBOARD_STEP)
    expect(resolveSeparatorKeyboardSize("ArrowRight", state)).toBeUndefined()
  })

  test("inverts arrow growth for start-edge separators", () => {
    const state = { ...base, direction: "horizontal" as const, edge: "start" as const }
    expect(resolveSeparatorKeyboardSize("ArrowLeft", state)).toBe(300 + RESIZE_KEYBOARD_STEP)
    expect(resolveSeparatorKeyboardSize("ArrowRight", state)).toBe(300 - RESIZE_KEYBOARD_STEP)
  })

  test("jumps to the band extremes on Home and End", () => {
    const state = { ...base, direction: "horizontal" as const }
    expect(resolveSeparatorKeyboardSize("Home", state)).toBe(220)
    expect(resolveSeparatorKeyboardSize("End", state)).toBe(420)
  })

  test("ignores unrelated keys", () => {
    for (const key of ["Enter", " ", "Escape", "a", "PageUp"]) {
      expect(resolveSeparatorKeyboardSize(key, { ...base, direction: "horizontal" })).toBeUndefined()
    }
  })
})

describe("clampSeparatorSize", () => {
  test("rounds and clamps", () => {
    expect(clampSeparatorSize(340.6, { min: 220, max: 420 })).toBe(341)
    expect(clampSeparatorSize(40, { min: 220, max: 420 })).toBe(220)
    expect(clampSeparatorSize(9999, { min: 220, max: 420 })).toBe(420)
  })
})

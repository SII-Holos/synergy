import { describe, expect, test } from "bun:test"
import { inputModifiers } from "../src/browser-input.js"

describe("browser input helpers", () => {
  test("normalizes Browser workspace modifiers for Electron input events", () => {
    expect(inputModifiers(["Shift", "Control", "Alt", "Meta"])).toEqual(["shift", "control", "alt", "meta"])
  })

  test("adds Electron auto-repeat modifier when requested", () => {
    expect(inputModifiers(["Shift"], { autoRepeat: true })).toEqual(["shift", "isautorepeat"])
  })

  test("drops unsupported modifier values", () => {
    expect(inputModifiers(["Shift", "Hyper", null])).toEqual(["shift"])
  })
})

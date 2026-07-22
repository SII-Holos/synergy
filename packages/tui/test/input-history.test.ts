import { describe, expect, test } from "bun:test"
import { createInputHistory } from "../src/input-history"

describe("composer input history", () => {
  test("records non-empty entries and removes adjacent duplicates", () => {
    const history = createInputHistory(3)
    history.record(" first ")
    history.record("first")
    history.record("second")
    expect(history.entries()).toEqual(["first", "second"])
  })

  test("bounds retained history", () => {
    const history = createInputHistory(2)
    history.record("one")
    history.record("two")
    history.record("three")
    expect(history.entries()).toEqual(["two", "three"])
  })

  test("navigates backward and restores the draft", () => {
    const history = createInputHistory(5)
    history.record("one")
    history.record("two")
    expect(history.previous("draft")).toBe("two")
    expect(history.previous("ignored")).toBe("one")
    expect(history.next()).toBe("two")
    expect(history.next()).toBe("draft")
  })

  test("resets navigation when input changes or is recorded", () => {
    const history = createInputHistory(5)
    history.record("one")
    expect(history.previous("draft")).toBe("one")
    history.resetNavigation()
    expect(history.next()).toBeUndefined()
    expect(history.previous("new draft")).toBe("one")
    history.record("two")
    expect(history.next()).toBeUndefined()
  })
})

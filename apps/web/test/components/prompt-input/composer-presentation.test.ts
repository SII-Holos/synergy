import { describe, expect, test } from "bun:test"
import {
  ComposerPresentation,
  expandedComposerKeyAction,
  formatComposerSelection,
} from "../../../src/components/prompt-input/composer-presentation"

describe("long message presentation", () => {
  test("acceptance collapses only the cleared draft that belongs to the receipt", () => {
    const state = new ComposerPresentation()
    state.expand()
    state.setView("preview")
    state.accepted(false)
    expect(state.expanded).toBe(true)
    expect(state.view).toBe("preview")
    state.accepted(true)
    expect(state.expanded).toBe(false)
    state.expand()
    expect(state.view).toBe("edit")
  })
  test("expanded editing reserves arrows and Enter, and respects IME", () => {
    const key = (value: string, modifiers = {}) =>
      expandedComposerKeyAction({
        key: value,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        ...modifiers,
      })
    expect(key("Enter")).toBe("newline")
    expect(key("Enter", { metaKey: true })).toBe("send")
    expect(key("Enter", { isComposing: true })).toBe("edit")
    expect(key("ArrowUp")).toBe("edit")
    expect(key("ArrowDown")).toBe("edit")
    expect(key("Escape")).toBe("collapse")
  })
  test("formatting edits source in UTF-16 coordinates", () => {
    expect(formatComposerSelection("你好 😀", { start: 3, end: 5 }, "bold")).toEqual({
      range: { start: 3, end: 5 },
      text: "**😀**",
    })
    expect(formatComposerSelection("first\nsecond", { start: 2, end: 9 }, "quote")).toEqual({
      range: { start: 0, end: 12 },
      text: "> first\n> second",
    })
    expect(formatComposerSelection("x", { start: 1, end: 1 }, "code").text).toBe("` `")
  })
})

import { describe, expect, test } from "bun:test"
import {
  ComposerResizeGesture,
  composerBodyLimits,
  ComposerPresentation,
  expandedComposerKeyAction,
  formatComposerSelection,
} from "../../../src/components/prompt-input/composer-presentation"

describe("long message presentation", () => {
  test("resize obeys measured chat height and uses a 32 pixel expansion hysteresis", () => {
    expect(composerBodyLimits(500, 60)).toEqual({ minimum: 96, automatic: 200, manual: 240 })
    const drag = new ComposerResizeGesture({ y: 300, height: 120, maximum: 240, minimum: 96 })
    expect(drag.move(180)).toMatchObject({ height: 240, expand: false })
    expect(drag.move(140)).toMatchObject({ height: 240, expand: true })
    expect(drag.move(165).expand).toBe(true)
    expect(drag.move(185).expand).toBe(false)
    expect(drag.move(900).height).toBe(96)
    expect(composerBodyLimits(120, 80).manual).toBeLessThan(96)
  })
  test("pull feedback advances beyond the height cap without expanding before release", () => {
    const drag = new ComposerResizeGesture({ y: 300, height: 120, maximum: 240, minimum: 96 })
    expect(drag.move(180)).toMatchObject({ height: 240, progress: 0, pull: 0, expand: false })
    const approaching = drag.move(164)
    expect(approaching.progress).toBe(0.5)
    expect(approaching.pull).toBeGreaterThan(0)
    expect(approaching.expand).toBe(false)
    const armed = drag.move(148)
    expect(armed).toMatchObject({ height: 240, progress: 1, expand: true })
    const farther = drag.move(100)
    expect(farther.height).toBe(240)
    expect(farther.pull).toBeGreaterThan(armed.pull)
    expect(farther.pull).toBeLessThan(8)
    expect(drag.move(165).expand).toBe(true)
    expect(drag.move(180)).toMatchObject({ progress: 0, pull: 0, expand: false })
  })
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

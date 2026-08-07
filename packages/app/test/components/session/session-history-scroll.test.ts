import { describe, expect, test } from "bun:test"
import {
  adjustedScrollTop,
  adjustTrimScrollTop,
  computeTurnTrim,
  selectPrependAnchor,
} from "../../../src/components/session/session-history-scroll"

describe("session history prepend scroll", () => {
  test("anchors the first message intersecting the viewport", () => {
    expect(
      selectPrependAnchor(
        [
          { messageID: "older", top: -120, bottom: -20 },
          { messageID: "visible", top: -20, bottom: 80 },
          { messageID: "next", top: 80, bottom: 180 },
        ],
        0,
      ),
    ).toEqual({ messageID: "visible", offsetTop: -20 })
  })

  test("compensates scrollTop by the anchored message displacement", () => {
    expect(adjustedScrollTop({ scrollTop: 360, beforeOffsetTop: -20, afterOffsetTop: 180 })).toBe(560)
  })
})

describe("adjustTrimScrollTop (top-trim removal direction)", () => {
  test("decreases scrollTop by the removed height to keep the same visual position", () => {
    // Before trim: 5000 content in a 600 viewport, scrolled to 4000.
    // After trimming 1200 from the top: 3800 content, same visual position at 2800.
    expect(
      adjustTrimScrollTop({ scrollTop: 4000, beforeScrollHeight: 5000, afterScrollHeight: 3800, clientHeight: 600 }),
    ).toBe(2800)
  })

  test("clamps to the new max when the previous position is past the end", () => {
    expect(
      adjustTrimScrollTop({ scrollTop: 5000, beforeScrollHeight: 5000, afterScrollHeight: 3800, clientHeight: 600 }),
    ).toBe(3200)
  })

  test("clamps to zero when the delta would push below the top", () => {
    expect(
      adjustTrimScrollTop({ scrollTop: 100, beforeScrollHeight: 5000, afterScrollHeight: 3800, clientHeight: 600 }),
    ).toBe(0)
  })

  test("returns zero for an empty container", () => {
    expect(adjustTrimScrollTop({ scrollTop: 0, beforeScrollHeight: 0, afterScrollHeight: 0, clientHeight: 600 })).toBe(
      0,
    )
  })
})

describe("computeTurnTrim (turnStart auto-advance guard)", () => {
  const base = {
    visibleRootCount: 60,
    turnStart: 10,
    maxRenderedTurns: 40,
    historyMode: false,
    scrolledUp: false,
    userScrolled: false,
    distanceFromBottom: 0,
    pinnedThreshold: 10,
  }

  test("trims to maxRenderedTurns when pinned at the bottom and over the cap", () => {
    expect(computeTurnTrim(base)).toEqual({ trim: true, nextTurnStart: 20 })
  })

  test("does not trim when the rendered window is within the cap", () => {
    expect(computeTurnTrim({ ...base, visibleRootCount: 50, turnStart: 10 })).toEqual({ trim: false })
  })

  test("does not trim when turnStart is 0 (full window already)", () => {
    expect(computeTurnTrim({ ...base, turnStart: 0 })).toEqual({ trim: false })
  })

  test("does not trim when there are no roots", () => {
    expect(computeTurnTrim({ ...base, visibleRootCount: 0 })).toEqual({ trim: false })
  })

  test("does not trim in history mode", () => {
    expect(computeTurnTrim({ ...base, historyMode: true })).toEqual({ trim: false })
  })

  test("does not trim when scrolled up", () => {
    expect(computeTurnTrim({ ...base, scrolledUp: true })).toEqual({ trim: false })
  })

  test("does not trim when the user scrolled", () => {
    expect(computeTurnTrim({ ...base, userScrolled: true })).toEqual({ trim: false })
  })

  test("does not trim when not pinned to the bottom", () => {
    expect(computeTurnTrim({ ...base, distanceFromBottom: 200 })).toEqual({ trim: false })
  })

  test("trims when distanceFromBottom is inside the pinned threshold", () => {
    expect(computeTurnTrim({ ...base, distanceFromBottom: 9 })).toEqual({ trim: true, nextTurnStart: 20 })
  })
})

import { describe, expect, test } from "bun:test"
import { adjustedScrollTop, selectPrependAnchor } from "./session-history-scroll"

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

import { describe, expect, test } from "bun:test"
import { pendingTimelineActions } from "./pending-timeline-item-model"

describe("pending timeline message actions", () => {
  test("lets queued tasks guide the current run or withdraw", () => {
    expect(
      pendingTimelineActions("task").map((action) => ({ kind: action.kind, label: action.label.message })),
    ).toEqual([
      { kind: "guide", label: "Guide" },
      { kind: "withdraw", label: "Withdraw" },
    ])
  })

  test("lets active steers move back to the queue or withdraw", () => {
    expect(
      pendingTimelineActions("steer").map((action) => ({ kind: action.kind, label: action.label.message })),
    ).toEqual([
      { kind: "queue", label: "Queue" },
      { kind: "withdraw", label: "Withdraw" },
    ])
  })

  test("keeps context-only inbox updates non-interactive", () => {
    expect(pendingTimelineActions("context")).toEqual([])
  })
})

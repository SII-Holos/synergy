import { describe, expect, test } from "bun:test"
import { pendingTimelineItemView } from "./conversation-pending"

describe("pending timeline item presentation", () => {
  test("offers Guide for queued tasks and Queue for steering items", () => {
    expect(pendingTimelineItemView("task", false)).toEqual({
      frozen: false,
      primaryAction: "guide",
      canWithdraw: true,
    })
    expect(pendingTimelineItemView("steer", false)).toEqual({
      frozen: false,
      primaryAction: "queue",
      canWithdraw: true,
    })
  })

  test("freezes all pending actions during rollback", () => {
    expect(pendingTimelineItemView("task", true)).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
    expect(pendingTimelineItemView("steer", true)).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
  })
})

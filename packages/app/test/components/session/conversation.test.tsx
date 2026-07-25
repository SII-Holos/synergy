import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import {
  pendingTimelineItemView,
  selectPendingTimelineItems,
} from "../../../src/components/session/conversation-pending"

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

  test("hides a pending item after its canonical message is present", () => {
    const pending = {
      id: "inb_first",
      sessionID: "ses_first",
      mode: "task",
      messageID: "msg_first",
      message: {
        role: "user",
        parts: [],
        origin: { type: "user" },
        visible: true,
      },
      summary: { title: "First message" },
      source: { type: "user" },
      time: { created: 1 },
      orderKey: "001",
    } satisfies SessionInboxItem

    expect(selectPendingTimelineItems([pending], [])).toEqual([pending])
    expect(selectPendingTimelineItems([pending], [{ id: "msg_first" }])).toEqual([])
  })
})

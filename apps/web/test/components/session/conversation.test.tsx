import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import {
  pendingTimelineItemView,
  selectPendingTimelineItems,
} from "../../../src/components/session/conversation-pending"

describe("pending timeline item presentation", () => {
  test("locks the first pending root until a canonical root exists", () => {
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: false })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: true })).toEqual({
      frozen: false,
      primaryAction: "guide",
      canWithdraw: true,
    })
    expect(pendingTimelineItemView("steer", false, { hasCanonicalRoot: true })).toEqual({
      frozen: false,
      primaryAction: "queue",
      canWithdraw: true,
    })
  })

  test("freezes all pending actions during rollback", () => {
    expect(pendingTimelineItemView("task", true, { hasCanonicalRoot: true })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
    expect(pendingTimelineItemView("steer", true, { hasCanonicalRoot: true })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
  })

  test("failed initialization can be withdrawn without enabling guide actions", () => {
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: false, status: "failed" })).toEqual({
      frozen: false,
      primaryAction: undefined,
      canWithdraw: true,
    })
    expect(pendingTimelineItemView("task", true, { hasCanonicalRoot: false, status: "failed" })).toEqual({
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
    const renderedOptimisticMessage: { id: string; metadata?: unknown } = {
      id: "msg_first",
      metadata: { synergyClientOptimistic: { pending: true } },
    }
    expect(selectPendingTimelineItems([pending], [renderedOptimisticMessage])).toEqual([])
    const steer = { ...pending, id: "inb_steer", messageID: "msg_steer", mode: "steer" as const }
    const context = { ...pending, id: "inb_context", mode: "context" as const }
    const hidden = { ...pending, id: "inb_hidden", message: { ...pending.message, visible: false } }
    const agent = {
      ...pending,
      id: "inb_agent",
      message: { ...pending.message, origin: { type: "agent" as const } },
    }
    const sourceOnly = { ...pending, id: "inb_source", messageID: "msg_source", message: undefined }
    expect(
      selectPendingTimelineItems([context, hidden, agent, steer, sourceOnly, pending], []).map((item) => item.id),
    ).toEqual([steer.id, sourceOnly.id, pending.id])
  })
})

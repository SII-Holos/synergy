import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import { deriveSessionInboxView, isInboxItemInteractive, sortInboxItems } from "./session-inbox-utils"

function item(
  id: string,
  kind: SessionInboxItem["kind"],
  deliveryTarget: SessionInboxItem["deliveryTarget"],
  orderKey: string,
  mode?: SessionInboxItem["mode"],
): SessionInboxItem {
  return {
    id,
    sessionID: "ses_test",
    kind,
    state: kind === "guiding" ? "guiding" : "queued",
    deliveryTarget,
    mode: mode ?? (kind === "guiding" ? "steer" : kind === "agent_update" ? "steer" : ("task" as const)),
    messageID: `msg_${id}`,
    summary: { title: id },
    source: { type: "test" },
    time: { created: 1 },
    orderKey,
  }
}

describe("sortInboxItems", () => {
  test("sorts by mode first, then queue order", () => {
    const queuedEarly = item("inb_queued_early", "queued_user", "after_turn", "001", "task")
    const contextMiddle = item("inb_context_middle", "agent_update", "next_model_call", "002", "context")
    const steerLate = item("inb_steer_late", "guiding", "next_model_call", "003", "steer")

    expect(sortInboxItems([contextMiddle, steerLate, queuedEarly]).map((entry) => entry.id)).toEqual([
      "inb_steer_late",
      "inb_queued_early",
      "inb_context_middle",
    ])
  })
})

describe("deriveSessionInboxView", () => {
  test("treats missing inbox data as loading, not empty", () => {
    const view = deriveSessionInboxView(undefined)

    expect(view.status).toBe("loading")
    expect(view.count).toBe(0)
    expect(view.items).toEqual([])
  })

  test("treats a loaded empty inbox as empty", () => {
    const view = deriveSessionInboxView([])

    expect(view.status).toBe("empty")
    expect(view.count).toBe(0)
    expect(view.items).toEqual([])
  })

  test("sorts loaded inbox items and reports the badge count", () => {
    const queuedEarly = item("inb_queued_early", "queued_user", "after_turn", "001")
    const guidingLate = item("inb_guiding_late", "guiding", "next_model_call", "003")
    const view = deriveSessionInboxView([queuedEarly, guidingLate])

    expect(view.status).toBe("ready")
    expect(view.count).toBe(2)
    expect(view.items.map((entry) => entry.id)).toEqual(["inb_guiding_late", "inb_queued_early"])
  })
})

describe("isInboxItemInteractive", () => {
  test("only queued user messages are interactive", () => {
    expect(isInboxItemInteractive(item("inb_queued", "queued_user", "after_turn", "001"))).toBe(true)
    expect(isInboxItemInteractive(item("inb_guiding", "guiding", "next_model_call", "002"))).toBe(false)
    expect(isInboxItemInteractive(item("inb_agent", "agent_update", "after_turn", "003"))).toBe(false)
  })
})

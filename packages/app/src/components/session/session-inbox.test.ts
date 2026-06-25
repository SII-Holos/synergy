import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import { isInboxItemInteractive, sortInboxItems } from "./session-inbox-utils"

function item(
  id: string,
  kind: SessionInboxItem["kind"],
  deliveryTarget: SessionInboxItem["deliveryTarget"],
  orderKey: string,
): SessionInboxItem {
  return {
    id,
    sessionID: "ses_test",
    kind,
    state: kind === "guiding" ? "guiding" : "queued",
    deliveryTarget,
    summary: { title: id },
    source: { type: "test" },
    time: { created: 1 },
    orderKey,
  }
}

describe("sortInboxItems", () => {
  test("keeps all inbox kinds in one delivery-ordered queue", () => {
    const queuedEarly = item("inb_queued_early", "queued_user", "after_turn", "001")
    const agentMiddle = item("inb_agent_middle", "agent_update", "after_turn", "002")
    const guidingLate = item("inb_guiding_late", "guiding", "next_model_call", "003")

    expect(sortInboxItems([agentMiddle, guidingLate, queuedEarly]).map((entry) => entry.id)).toEqual([
      "inb_guiding_late",
      "inb_queued_early",
      "inb_agent_middle",
    ])
  })
})

describe("isInboxItemInteractive", () => {
  test("only queued user messages are interactive", () => {
    expect(isInboxItemInteractive(item("inb_queued", "queued_user", "after_turn", "001"))).toBe(true)
    expect(isInboxItemInteractive(item("inb_guiding", "guiding", "next_model_call", "002"))).toBe(false)
    expect(isInboxItemInteractive(item("inb_agent", "agent_update", "after_turn", "003"))).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import { deriveSessionInboxView, isInboxItemInteractive, sortInboxItems } from "./session-inbox-utils"

function item(id: string, mode: SessionInboxItem["mode"], orderKey: string): SessionInboxItem {
  return {
    id,
    sessionID: "ses_test",
    mode,
    messageID: `msg_${id}`,
    summary: { title: id },
    source: { type: "test" },
    time: { created: 1 },
    orderKey,
  }
}

describe("sortInboxItems", () => {
  test("sorts by mode first, then queue order", () => {
    const queuedEarly = item("inb_queued_early", "task", "001")
    const contextMiddle = item("inb_context_middle", "context", "002")
    const steerLate = item("inb_steer_late", "steer", "003")

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
    const queuedEarly = item("inb_queued_early", "task", "001")
    const guidingLate = item("inb_guiding_late", "steer", "003")
    const view = deriveSessionInboxView([queuedEarly, guidingLate])

    expect(view.status).toBe("ready")
    expect(view.count).toBe(2)
    expect(view.items.map((entry) => entry.id)).toEqual(["inb_guiding_late", "inb_queued_early"])
  })
})

describe("isInboxItemInteractive", () => {
  test("only queued user messages are interactive", () => {
    expect(isInboxItemInteractive(item("inb_queued", "task", "001"))).toBe(true)
    expect(isInboxItemInteractive(item("inb_guiding", "steer", "002"))).toBe(false)
    expect(isInboxItemInteractive(item("inb_agent", "context", "003"))).toBe(false)
  })
})

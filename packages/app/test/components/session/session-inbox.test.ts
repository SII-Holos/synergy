import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import {
  deriveSessionInboxView,
  isInboxItemInteractive,
  isInboxItemMaterialized,
  removeMaterializedInboxItems,
  sortInboxItems,
  upsertSessionInboxItem,
} from "../../../src/components/session/session-inbox-utils"

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

describe("upsertSessionInboxItem", () => {
  test("makes an accepted item visible without waiting for an inbox event", () => {
    const accepted = item("inb_accepted", "task", "002")
    const existing = item("inb_existing", "task", "001")

    expect(upsertSessionInboxItem(undefined, accepted)).toEqual([accepted])
    expect(upsertSessionInboxItem([accepted, existing], { ...accepted, summary: { title: "Updated" } })).toEqual([
      existing,
      { ...accepted, summary: { title: "Updated" } },
    ])
  })
})

describe("isInboxItemInteractive", () => {
  test("task and steer user messages are interactive", () => {
    expect(isInboxItemInteractive(item("inb_queued", "task", "001"))).toBe(true)
    expect(isInboxItemInteractive(item("inb_guiding", "steer", "002"))).toBe(true)
    expect(isInboxItemInteractive(item("inb_agent", "context", "003"))).toBe(false)
  })
})

describe("removeMaterializedInboxItems", () => {
  test("drops only the item whose message was materialized", () => {
    const consumed = item("inb_consumed", "task", "001")
    const waiting = item("inb_waiting", "task", "002")

    expect(removeMaterializedInboxItems([consumed, waiting], consumed.messageID)?.map((entry) => entry.id)).toEqual([
      waiting.id,
    ])
  })

  test("keeps reference identity when nothing matches", () => {
    const items = [item("inb_a", "task", "001")]

    expect(removeMaterializedInboxItems(items, "msg_unrelated")).toBe(items)
    expect(removeMaterializedInboxItems(undefined, "msg_any")).toBeUndefined()
    expect(removeMaterializedInboxItems([], "msg_any")).toEqual([])
  })
})

describe("isInboxItemMaterialized", () => {
  test("treats a canonical transcript message as materialized", () => {
    const queued = item("inb_queued", "task", "001")
    const canonical = { id: queued.messageID }

    expect(isInboxItemMaterialized([canonical], queued, () => false)).toBe(true)
  })

  test("ignores the local optimistic placeholder", () => {
    const queued = item("inb_queued", "task", "001")
    const placeholder = { id: queued.messageID }

    expect(isInboxItemMaterialized([placeholder], queued, () => true)).toBe(false)
  })

  test("returns false when the window is not loaded", () => {
    const queued = item("inb_queued", "task", "001")

    expect(isInboxItemMaterialized(undefined, queued, () => false)).toBe(false)
    expect(isInboxItemMaterialized([{ id: "msg_other" }], queued, () => false)).toBe(false)
  })
})

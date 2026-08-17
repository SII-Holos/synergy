import { describe, expect, test } from "bun:test"
import type { Message } from "@ericsanchezok/synergy-sdk"
import { buildConversationTimelineSnapshot } from "../../../src/components/session/conversation-timeline"

function message(id: string, role: "user" | "assistant" = "user"): Message {
  return { id, sessionID: "ses_1", role, time: { created: 1 } } as unknown as Message
}

describe("buildConversationTimelineSnapshot", () => {
  test("keys rows by stable message id across object replacement", () => {
    const first = buildConversationTimelineSnapshot([message("msg_a"), message("msg_b")])
    // Simulates window reload / reconnect replay / message.updated reconcile:
    // same ids, brand-new object references.
    const second = buildConversationTimelineSnapshot([message("msg_a"), message("msg_b")])

    expect(first.keys).toEqual(second.keys)
    expect(first.keys).toEqual(["msg_a", "msg_b"])
  })

  test("map returns the latest message object for each id", () => {
    const updated = message("msg_a")
    const snapshot = buildConversationTimelineSnapshot([updated, message("msg_b")])

    expect(snapshot.map.get("msg_a")).toBe(updated)
    expect(snapshot.map.get("msg_b")?.id).toBe("msg_b")
  })

  test("preserves timeline order and drops removed ids", () => {
    const withThree = buildConversationTimelineSnapshot([message("msg_a"), message("msg_b"), message("msg_c")])
    expect(withThree.keys).toEqual(["msg_a", "msg_b", "msg_c"])

    const afterRemoval = buildConversationTimelineSnapshot([message("msg_a"), message("msg_c")])
    expect(afterRemoval.keys).toEqual(["msg_a", "msg_c"])
    expect(afterRemoval.map.has("msg_b")).toBe(false)
  })

  test("handles empty timelines", () => {
    const snapshot = buildConversationTimelineSnapshot([])
    expect(snapshot.keys).toEqual([])
    expect(snapshot.map.size).toBe(0)
  })
})

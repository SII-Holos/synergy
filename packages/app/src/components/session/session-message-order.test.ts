import { describe, expect, test } from "bun:test"
import { messagesBefore, messagesFrom, previousMessage, selectMessagesInCanonicalOrder } from "./session-message-order"

const canonical = [{ id: "msg_z" }, { id: "msg_1" }, { id: "msg_a" }]

describe("session message order", () => {
  test("cuts rollback history by canonical position instead of lexical id", () => {
    expect(messagesBefore(canonical, "msg_a")).toEqual([{ id: "msg_z" }, { id: "msg_1" }])
    expect(previousMessage(canonical, "msg_a")).toEqual({ id: "msg_1" })
  })

  test("starts rendered history at the canonical boundary", () => {
    expect(messagesFrom(canonical, "msg_1")).toEqual([{ id: "msg_1" }, { id: "msg_a" }])
  })

  test("orders timeline selections by the canonical message array", () => {
    expect(selectMessagesInCanonicalOrder(canonical, [{ id: "msg_a" }, { id: "msg_z" }])).toEqual([
      { id: "msg_z" },
      { id: "msg_a" },
    ])
  })

  test("leaves a window unchanged when its boundary is not loaded", () => {
    expect(messagesBefore(canonical, "msg_missing")).toEqual(canonical)
    expect(messagesFrom(canonical, "msg_missing")).toEqual(canonical)
    expect(previousMessage(canonical, "msg_missing")).toBeUndefined()
  })
})

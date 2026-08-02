import { describe, expect, test } from "bun:test"
import {
  messagesBefore,
  messagesFrom,
  messagesHiddenByRollback,
  previousMessage,
  selectMessagesInCanonicalOrder,
} from "../../../src/components/session/session-message-order"

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

describe("rollback message filtering", () => {
  const history = [{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_3" }, { id: "msg_4" }]
  const rollback = {
    cutMessageID: "msg_3",
    canUnrollback: true,
    droppedMessageIDs: ["msg_3", "msg_4"],
  }

  test("prefix-cuts the dropped branch while redo is possible", () => {
    expect(messagesHiddenByRollback(history, rollback)).toEqual([{ id: "msg_1" }, { id: "msg_2" }])
  })

  test("filters only the dropped set once redo is unavailable", () => {
    const replacement = [...history, { id: "msg_5" }]
    expect(messagesHiddenByRollback(replacement, { ...rollback, canUnrollback: false })).toEqual([
      { id: "msg_1" },
      { id: "msg_2" },
      { id: "msg_5" },
    ])
  })

  test("keeps a loaded post-cut branch visible while the summary still allows redo", () => {
    // The rollback summary can lag the message window: message.updated for the
    // resent input arrives before session.updated flips canUnrollback. A strict
    // prefix-cut would hide the new branch until a forced refresh.
    const replacement = [...history, { id: "msg_5" }]
    expect(messagesHiddenByRollback(replacement, rollback)).toEqual([{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_5" }])
  })

  test("leaves the window unchanged when the cut message is not loaded", () => {
    expect(messagesHiddenByRollback(history, { ...rollback, cutMessageID: "msg_missing" })).toEqual(history)
  })

  test("returns a copy when there is nothing to hide", () => {
    const result = messagesHiddenByRollback(history, {
      canUnrollback: false,
      droppedMessageIDs: [],
    })
    expect(result).toEqual(history)
    expect(result).not.toBe(history)
  })
})

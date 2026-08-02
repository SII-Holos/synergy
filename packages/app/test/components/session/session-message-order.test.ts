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
  const history = [
    { id: "msg_1", role: "user" as const, isRoot: true, time: { created: 1 } },
    { id: "msg_2", role: "assistant" as const, time: { created: 2 } },
    { id: "msg_3", role: "user" as const, isRoot: true, time: { created: 3 } },
    { id: "msg_4", role: "assistant" as const, time: { created: 4 } },
  ]
  const rollback = {
    created: 5,
    cutMessageID: "msg_3",
    canUnrollback: true,
    droppedMessageIDs: ["msg_3", "msg_4"],
  }

  test("prefix-cuts the dropped branch while redo is possible", () => {
    expect(messagesHiddenByRollback(history, rollback).map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  })

  test("filters only the dropped set once redo is unavailable", () => {
    const replacement = [...history, { id: "msg_5", role: "user" as const, isRoot: true, time: { created: 6 } }]
    expect(
      messagesHiddenByRollback(replacement, { ...rollback, canUnrollback: false }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2", "msg_5"])
  })

  test("keeps a loaded replacement root visible while the summary still allows redo", () => {
    const replacement = [...history, { id: "msg_5", role: "user" as const, isRoot: true, time: { created: 6 } }]
    expect(messagesHiddenByRollback(replacement, rollback).map((message) => message.id)).toEqual([
      "msg_1",
      "msg_2",
      "msg_5",
    ])
  })

  test("keeps a post-cut non-root injection hidden while redo is possible", () => {
    const injection = [...history, { id: "msg_5", role: "user" as const, isRoot: false, time: { created: 6 } }]
    expect(messagesHiddenByRollback(injection, rollback).map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  })

  test("leaves the window unchanged when the cut message is not loaded", () => {
    expect(messagesHiddenByRollback(history, { ...rollback, cutMessageID: "msg_missing" })).toEqual(history)
  })

  test("returns a copy when there is nothing to hide", () => {
    const result = messagesHiddenByRollback(history, {
      created: 0,
      canUnrollback: false,
      droppedMessageIDs: [],
    })
    expect(result).toEqual(history)
    expect(result).not.toBe(history)
  })
})

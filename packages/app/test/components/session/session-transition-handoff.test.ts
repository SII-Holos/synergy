import { describe, expect, test } from "bun:test"
import {
  SESSION_TRANSITION_HANDOFF_TIMEOUT_MS,
  decideSessionTransitionHandoff,
  isSessionTransitionHandoffReady,
  recoverSessionTransitionHandoff,
} from "../../../src/components/session/session-transition-handoff"

const messageID = "msg_first"

describe("new session transition handoff", () => {
  test("waits for the expected visible canonical root message", () => {
    expect(isSessionTransitionHandoffReady(messageID, [])).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: false, visible: true }]),
    ).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: true, visible: false }]),
    ).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_other", role: "user", isRoot: true, visible: true }]),
    ).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: true, visible: true }]),
    ).toBe(true)
  })

  test("refreshes once when the inbox commits before the root is observed", () => {
    const input = {
      messageID,
      messages: [],
      inbox: [],
      elapsedMs: 1_000,
    }

    expect(decideSessionTransitionHandoff({ ...input, refreshAttempted: false })).toBe("refresh")
    expect(decideSessionTransitionHandoff({ ...input, refreshAttempted: true })).toBe("waiting")
  })

  test("stalls after the bounded handoff deadline but still prefers a canonical root", () => {
    const stalled = {
      messageID,
      messages: [],
      inbox: [{ messageID }],
      refreshAttempted: false,
      elapsedMs: SESSION_TRANSITION_HANDOFF_TIMEOUT_MS,
    }

    expect(decideSessionTransitionHandoff(stalled)).toBe("stalled")
    expect(
      decideSessionTransitionHandoff({
        ...stalled,
        messages: [{ id: messageID, role: "user", isRoot: true, visible: true }],
      }),
    ).toBe("ready")
  })

  test("recovers an accepted handoff from one durable first task", () => {
    const pending = {
      id: "inb_first",
      mode: "task",
      messageID,
      message: {
        role: "user",
        origin: { type: "user" },
        visible: true,
        metadata: { sessionTransition: { workspaceSelection: { mode: "create" as const } } },
      },
      source: { type: "user" },
      time: { created: 123 },
    }

    expect(recoverSessionTransitionHandoff({ messages: [], inbox: [pending] })).toEqual({
      itemID: "inb_first",
      messageID,
      acceptedAt: 123,
      workspaceSelection: { mode: "create" },
    })
    expect(recoverSessionTransitionHandoff({ messages: [{ id: "msg_existing" }], inbox: [pending] })).toBeUndefined()
    expect(
      recoverSessionTransitionHandoff({ messages: [], inbox: [pending, { ...pending, id: "inb_second" }] }),
    ).toBeUndefined()
  })
})

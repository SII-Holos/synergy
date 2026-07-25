import { describe, expect, test } from "bun:test"
import { isSessionTransitionHandoffReady } from "../../../src/components/session/session-transition-handoff"

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
})

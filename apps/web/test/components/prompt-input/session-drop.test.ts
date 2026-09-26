import { describe, expect, test } from "bun:test"
import { decideDroppedSession } from "../../../src/components/prompt-input/session-drop"
import type { SessionAttachmentPart } from "../../../src/context/prompt"

const existing: SessionAttachmentPart[] = [
  { type: "session", id: "part-1", sessionId: "ses_dup", scopeID: "/repo", title: "Dup" },
]

describe("decideDroppedSession", () => {
  test("accepts a project session reference with a non-empty directory", () => {
    expect(
      decideDroppedSession({ connection: "http://server", id: "ses_b", scopeID: "/repo", title: "B" }, "ses_a", []),
    ).toEqual({
      accepted: true,
    })
  })

  test("accepts a home-scope session reference carrying the reserved home token", () => {
    expect(
      decideDroppedSession(
        { connection: "http://server", id: "ses_home_b", scopeID: "home", title: "Home B" },
        "ses_a",
        [],
      ),
    ).toEqual({
      accepted: true,
    })
  })

  test("rejects payloads missing id or directory", () => {
    expect(
      decideDroppedSession({ connection: "http://server", id: "", scopeID: "/repo", title: "T" }, "ses_a", []),
    ).toEqual({
      accepted: false,
      reason: "invalid",
    })
    expect(
      decideDroppedSession({ connection: "http://server", id: "ses_b", scopeID: "", title: "T" }, "ses_a", []),
    ).toEqual({
      accepted: false,
      reason: "invalid",
    })
  })

  test("rejects self-reference by id alone, even when directory differs", () => {
    expect(
      decideDroppedSession({ connection: "http://server", id: "ses_a", scopeID: "/other", title: "A" }, "ses_a", []),
    ).toEqual({
      accepted: false,
      reason: "self",
    })
    expect(
      decideDroppedSession({ connection: "http://server", id: "ses_a", scopeID: "home", title: "A" }, "ses_a", []),
    ).toEqual({
      accepted: false,
      reason: "self",
    })
  })

  test("rejects a duplicate reference with the same id and directory", () => {
    expect(
      decideDroppedSession(
        { connection: "http://server", id: "ses_dup", scopeID: "/repo", title: "Dup" },
        "ses_a",
        existing,
      ),
    ).toEqual({
      accepted: false,
      reason: "duplicate",
    })
  })

  test("allows the same session id from a different directory", () => {
    expect(
      decideDroppedSession(
        { connection: "http://server", id: "ses_dup", scopeID: "/other", title: "Dup" },
        "ses_a",
        existing,
      ),
    ).toEqual({
      accepted: true,
    })
  })
})

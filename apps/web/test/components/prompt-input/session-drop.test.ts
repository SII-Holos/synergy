import { describe, expect, test } from "bun:test"
import { decideDroppedSession } from "../../../src/components/prompt-input/session-drop"
import type { SessionAttachmentPart } from "../../../src/context/prompt"

const existing: SessionAttachmentPart[] = [
  { type: "session", id: "part-1", sessionId: "ses_dup", directory: "/repo", title: "Dup" },
]

describe("decideDroppedSession", () => {
  test("accepts a project session reference with a non-empty directory", () => {
    expect(decideDroppedSession({ id: "ses_b", directory: "/repo", title: "B" }, "ses_a", [])).toEqual({
      accepted: true,
    })
  })

  test("accepts a home-scope session reference carrying the reserved home token", () => {
    expect(decideDroppedSession({ id: "ses_home_b", directory: "home", title: "Home B" }, "ses_a", [])).toEqual({
      accepted: true,
    })
  })

  test("rejects payloads missing id or directory", () => {
    expect(decideDroppedSession({ id: "", directory: "/repo", title: "T" }, "ses_a", [])).toEqual({
      accepted: false,
      reason: "invalid",
    })
    expect(decideDroppedSession({ id: "ses_b", directory: "", title: "T" }, "ses_a", [])).toEqual({
      accepted: false,
      reason: "invalid",
    })
  })

  test("rejects self-reference by id alone, even when directory differs", () => {
    expect(decideDroppedSession({ id: "ses_a", directory: "/other", title: "A" }, "ses_a", [])).toEqual({
      accepted: false,
      reason: "self",
    })
    expect(decideDroppedSession({ id: "ses_a", directory: "home", title: "A" }, "ses_a", [])).toEqual({
      accepted: false,
      reason: "self",
    })
  })

  test("rejects a duplicate reference with the same id and directory", () => {
    expect(decideDroppedSession({ id: "ses_dup", directory: "/repo", title: "Dup" }, "ses_a", existing)).toEqual({
      accepted: false,
      reason: "duplicate",
    })
  })

  test("allows the same session id from a different directory", () => {
    expect(decideDroppedSession({ id: "ses_dup", directory: "/other", title: "Dup" }, "ses_a", existing)).toEqual({
      accepted: true,
    })
  })
})

import { describe, expect, mock, test } from "bun:test"
import type { AttachmentPart } from "@ericsanchezok/synergy-sdk"

import { navigateToSessionAttachment, specialFileAttachmentSessionID } from "./special-file-attachment"

function attachment(metadata: Record<string, unknown>): AttachmentPart {
  return {
    id: "prt_session",
    sessionID: "ses_parent",
    messageID: "msg_parent",
    type: "attachment",
    mime: "text/plain",
    url: "data:text/plain,session",
    metadata,
  }
}

describe("special file attachment", () => {
  test("navigates session attachments to their durable child session", () => {
    const navigateToSession = mock(() => undefined)
    const file = attachment({ kind: "session", sessionId: "ses_child123" })

    expect(specialFileAttachmentSessionID(file, "session")).toBe("ses_child123")
    expect(navigateToSessionAttachment({ file, kind: "session", navigateToSession })).toBe(true)
    expect(navigateToSession).toHaveBeenCalledWith("ses_child123")
  })

  test("leaves note and malformed session attachments inert", () => {
    const navigateToSession = mock(() => undefined)

    expect(
      navigateToSessionAttachment({
        file: attachment({ kind: "note", sessionId: "ses_child" }),
        kind: "note",
        navigateToSession,
      }),
    ).toBe(false)
    expect(
      navigateToSessionAttachment({
        file: attachment({ kind: "session" }),
        kind: "session",
        navigateToSession,
      }),
    ).toBe(false)
    expect(
      navigateToSessionAttachment({
        file: attachment({ kind: "session", sessionId: "ses_../other" }),
        kind: "session",
        navigateToSession,
      }),
    ).toBe(false)
    expect(navigateToSession).not.toHaveBeenCalled()
  })
})

import { describe, expect, test } from "bun:test"
import { createSessionCommandParts } from "../../../src/components/prompt-input/session-command"

describe("session command attachment parts", () => {
  test("session attachments encode data URLs with strict-atob-safe standard base64", () => {
    const parts = createSessionCommandParts({
      sessions: [
        {
          type: "session",
          id: "prt_session_fixture",
          sessionId: "ses_fixture",
          directory: "/repo",
          title: "Session <ref> & 长文本 🚀",
          updatedAt: 123,
        },
      ],
    })
    const attachment = parts.find((part) => part.type === "attachment")!
    expect(attachment.url.startsWith("data:text/plain;base64,")).toBe(true)

    const payload = attachment.url.slice("data:text/plain;base64,".length)
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)

    // The harness decoder path: strict atob must accept the payload and the
    // decoded bytes must round-trip the session-ref text.
    const decoded = atob(payload)
    const text = new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))
    expect(text).toContain('<session-ref id="ses_fixture"')
  })

  test("note attachments encode data URLs with standard base64", () => {
    const parts = createSessionCommandParts({
      notes: [
        {
          type: "note",
          id: "prt_note_fixture",
          noteId: "nte_fixture",
          title: "Note & <meta>",
          content: "正文 🚀",
        },
      ],
    })
    const attachment = parts.find((part) => part.type === "attachment")!
    const payload = attachment.url.slice("data:text/plain;base64,".length)
    expect(() => atob(payload)).not.toThrow()
    const decoded = atob(payload)
    const text = new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))
    expect(text).toContain("正文 🚀")
  })
})

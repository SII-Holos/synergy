import { describe, expect, test } from "bun:test"
import type { AttachmentPart, Part } from "@ericsanchezok/synergy-sdk"
import {
  ATTACHMENT_PDF_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_BYTES,
  attachmentResourceId,
  attachmentResourceState,
  classifyAttachmentPreview,
  fetchAttachmentBytes,
  findAttachmentByLocator,
} from "../../../src/components/attachment-workbench/model"

function attachment(input: Partial<AttachmentPart> = {}): AttachmentPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "attachment",
    mime: "application/pdf",
    filename: "report.pdf",
    url: "asset://report",
    ...input,
  }
}

describe("attachment workspace identity", () => {
  test("uses the session, message, and attachment identifiers as one stable resource", () => {
    const locator = { version: 1 as const, sessionID: "session/1", messageID: "message:1", attachmentID: "part 1" }
    expect(attachmentResourceId(locator)).toBe("session%2F1/message%3A1/part%201")
    expect(attachmentResourceState(locator)).toEqual(locator)
  })

  test("rejects incomplete or future persisted state", () => {
    expect(attachmentResourceState({ version: 2, sessionID: "s", messageID: "m", attachmentID: "a" })).toBeUndefined()
    expect(attachmentResourceState({ version: 1, sessionID: "s", messageID: "m" })).toBeUndefined()
    expect(attachmentResourceState(null)).toBeUndefined()
  })
})

describe("bounded attachment reads", () => {
  test("rejects declared and streamed payloads above the preview limit", async () => {
    await expect(
      fetchAttachmentBytes(
        async () => new Response("too large", { headers: { "content-length": "100" } }),
        "https://example.com/report.txt",
        10,
      ),
    ).rejects.toMatchObject({ name: "AttachmentTooLargeError" })

    await expect(
      fetchAttachmentBytes(
        async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
        "https://example.com/report.txt",
        4,
      ),
    ).rejects.toMatchObject({ name: "AttachmentTooLargeError" })
  })

  test("returns payload bytes without exceeding the bound", async () => {
    const bytes = await fetchAttachmentBytes(
      async () => new Response(new Uint8Array([1, 2, 3])),
      "https://example.com/report.txt",
      4,
    )
    expect([...bytes]).toEqual([1, 2, 3])
  })
})

describe("attachment workspace resolution", () => {
  test("finds top-level attachments by locator", () => {
    const expected = attachment()
    expect(
      findAttachmentByLocator([expected], {
        version: 1,
        sessionID: "session-1",
        messageID: "message-1",
        attachmentID: "part-1",
      }),
    ).toEqual(expected)
  })

  test("finds attachments nested in completed tool results", () => {
    const expected = attachment({ id: "nested-part" })
    const parts = [
      {
        id: "tool-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-1",
        tool: "attach",
        state: {
          status: "completed",
          input: {},
          output: "done",
          title: "report",
          metadata: {},
          time: { start: 1, end: 2 },
          attachments: [expected],
        },
      },
    ] as Part[]

    expect(
      findAttachmentByLocator(parts, {
        version: 1,
        sessionID: "session-1",
        messageID: "message-1",
        attachmentID: "nested-part",
      }),
    ).toEqual(expected)
  })
})

describe("attachment preview classification", () => {
  test("classifies previewable formats and preserves explicit source/preview modes", () => {
    expect(classifyAttachmentPreview("application/pdf", "report.pdf")).toEqual({
      kind: "pdf",
      defaultMode: "preview",
      dual: false,
      maxBytes: ATTACHMENT_PDF_MAX_BYTES,
    })
    expect(classifyAttachmentPreview("text/markdown", "README.md")).toEqual({
      kind: "markdown",
      defaultMode: "preview",
      dual: true,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
    expect(classifyAttachmentPreview("text/html", "report.html")).toEqual({
      kind: "html",
      defaultMode: "preview",
      dual: true,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
    expect(classifyAttachmentPreview("application/json", "result.json")).toEqual({
      kind: "source",
      defaultMode: "source",
      dual: false,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
  })

  test("uses native media players and download-only metadata for unsupported binaries", () => {
    expect(classifyAttachmentPreview("video/mp4", "clip.mp4").kind).toBe("video")
    expect(classifyAttachmentPreview("audio/mpeg", "clip.mp3").kind).toBe("audio")
    expect(
      classifyAttachmentPreview(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "report.docx",
      ).kind,
    ).toBe("unsupported")
    expect(classifyAttachmentPreview("application/zip", "bundle.zip").kind).toBe("unsupported")
  })
})

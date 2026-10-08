import { classifyResourcePreview } from "../../../src/components/resource-preview"
import { describe, expect, test } from "bun:test"
import type { AttachmentPart, Part } from "@ericsanchezok/synergy-sdk"
import {
  ATTACHMENT_PDF_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_BYTES,
  attachmentOpenInBrowserUrl,
  attachmentSourceMarkdown,
  attachmentWorkbenchPanelInit,
  attachmentResourceId,
  attachmentResourceState,
  createAttachmentPreviewReader,
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

  test("opens an immutable Markdown reference without hydrating a tool message", () => {
    const init = attachmentWorkbenchPanelInit({ url: "asset://0123456789abcdef.pdf", filename: "Report.pdf" })
    expect(init?.resourceId).toBe("asset://0123456789abcdef.pdf")
    expect(attachmentResourceState(init?.state)).toEqual({
      version: 1,
      url: "asset://0123456789abcdef.pdf",
      filename: "Report.pdf",
    })
    expect(attachmentWorkbenchPanelInit({ url: "asset://../private.pdf", filename: "bad.pdf" })).toBeUndefined()
  })

  test("rejects incomplete or future persisted state", () => {
    expect(attachmentResourceState({ version: 2, sessionID: "s", messageID: "m", attachmentID: "a" })).toBeUndefined()
    expect(attachmentResourceState({ version: 1, sessionID: "s", messageID: "m" })).toBeUndefined()
    expect(attachmentResourceState(null)).toBeUndefined()
  })

  test("leaves filename-less panel titles to the localized workbench fallback", () => {
    expect(attachmentWorkbenchPanelInit(attachment({ filename: undefined }))?.title).toBeUndefined()
    expect(attachmentWorkbenchPanelInit(attachment({ filename: "report.pdf" }))?.title).toBe("report.pdf")
  })
})

describe("bounded attachment reads", () => {
  test("a cancelled reader discards late results even when the transport ignores abort", async () => {
    const reply = Promise.withResolvers<Response>()
    const reader = createAttachmentPreviewReader(() => reply.promise)
    const pending = reader.read("https://example.com/draft.txt", 1024)
    reader.cancel()
    reply.resolve(new Response("stale"))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
  test("images have a direct reading capability without a fabricated session identity", () => {
    expect(classifyResourcePreview("image/png", "sample.png").kind).toBe("image")
    expect(attachmentWorkbenchPanelInit({ filename: "sample.png" })).toBeUndefined()
  })
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

  test("aborts the active preview read when the reader is disposed", async () => {
    let aborted = false
    const reader = createAttachmentPreviewReader((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true },
        )
      })
    })

    const pending = reader.read("https://example.com/report.pdf", ATTACHMENT_PDF_MAX_BYTES)
    reader.cancel()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(aborted).toBe(true)
  })

  test("replaces an in-flight preview read instead of stacking it", async () => {
    let calls = 0
    let aborted = 0
    const reader = createAttachmentPreviewReader((_input, init) => {
      calls++
      if (calls === 2) return Promise.resolve(new Response(new Uint8Array([2])))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true },
        )
      })
    })

    const first = reader.read("https://example.com/first.pdf", ATTACHMENT_PDF_MAX_BYTES)
    const second = reader.read("https://example.com/second.pdf", ATTACHMENT_PDF_MAX_BYTES)

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toEqual(new Uint8Array([2]))
    expect(aborted).toBe(1)
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
    expect(classifyResourcePreview("application/pdf", "report.pdf")).toEqual({
      kind: "pdf",
      defaultMode: "preview",
      dual: false,
      maxBytes: ATTACHMENT_PDF_MAX_BYTES,
    })
    expect(classifyResourcePreview("text/markdown", "README.md")).toEqual({
      kind: "markdown",
      defaultMode: "preview",
      dual: true,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
    expect(classifyResourcePreview("text/html", "report.html")).toEqual({
      kind: "html",
      defaultMode: "preview",
      dual: true,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
    expect(classifyResourcePreview("application/json", "result.json")).toEqual({
      kind: "source",
      defaultMode: "source",
      dual: false,
      maxBytes: ATTACHMENT_TEXT_MAX_BYTES,
    })
  })

  test("uses native media players and download-only metadata for unsupported binaries", () => {
    expect(classifyResourcePreview("video/mp4", "clip.mp4").kind).toBe("video")
    expect(classifyResourcePreview("audio/mpeg", "clip.mp3").kind).toBe("audio")
    expect(
      classifyResourcePreview("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx")
        .kind,
    ).toBe("docx")
    expect(classifyResourcePreview("application/zip", "bundle.zip").kind).toBe("unsupported")
    expect(classifyResourcePreview("application/msword", "old.doc").kind).toBe("unsupported")
  })
})

describe("attachment open-in-browser eligibility", () => {
  test("returns the asset URL only for HTML attachments with a resolvable URL", () => {
    const url = "http://127.0.0.1:51042/asset/85a8d7a97c14178e.html"
    expect(attachmentOpenInBrowserUrl("html", url)).toBe(url)
    expect(attachmentOpenInBrowserUrl("pdf", url)).toBeUndefined()
    expect(attachmentOpenInBrowserUrl("markdown", url)).toBeUndefined()
    expect(attachmentOpenInBrowserUrl("source", url)).toBeUndefined()
    expect(attachmentOpenInBrowserUrl("html", undefined)).toBeUndefined()
    expect(attachmentOpenInBrowserUrl(undefined, url)).toBeUndefined()
  })
})

test("read-only source retains Markdown and HTML as code even with fence characters", () => {
  expect(attachmentSourceMarkdown("~~~\n<script>raw</script>\n# 原文", "notes.md")).toBe(
    "~~~~markdown\n~~~\n<script>raw</script>\n# 原文\n~~~~",
  )
})

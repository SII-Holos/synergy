import { describe, expect, test } from "bun:test"
import { runPendingAttachmentUpload } from "../../../src/components/prompt-input/attachment-upload-flow"
import { createPendingAttachmentTracker } from "../../../src/components/prompt-input/pending-attachments"
import type { UploadedPromptAttachment } from "../../../src/utils/prompt-attachment"

function fakeFile(name = "video.mp4", type = "video/mp4", size = 1024) {
  return new File([new Uint8Array(size)], name, { type })
}

const uploadedResult: UploadedPromptAttachment = {
  mime: "video/mp4",
  url: "asset://video-1",
  size: 1024,
}

describe("pending attachment upload flow", () => {
  test("inserts the settled part under the pending id and flashes uploaded", async () => {
    const tracker = createPendingAttachmentTracker()
    const inserted: unknown[] = []
    let resolveUpload: (value: UploadedPromptAttachment) => void = () => {}
    const upload = () => new Promise<UploadedPromptAttachment>((resolve) => (resolveUpload = resolve))

    const done = runPendingAttachmentUpload({
      file: fakeFile(),
      id: "prt-1",
      tracker,
      upload,
      insertAttachment: (part) => inserted.push(part),
      isDestinationCurrent: () => true,
    })

    expect(tracker.pending()).toEqual([
      { id: "prt-1", filename: "video.mp4", mime: "video/mp4", size: 1024, status: "uploading" },
    ])
    expect(inserted).toEqual([])

    resolveUpload(uploadedResult)
    await done

    expect(inserted).toEqual([
      {
        type: "attachment",
        id: "prt-1",
        filename: "video.mp4",
        mime: "video/mp4",
        url: "asset://video-1",
        size: 1024,
        metadata: undefined,
        presentation: undefined,
      },
    ])
    expect(tracker.pending().map((entry) => entry.status)).toEqual(["uploaded"])
    expect(tracker.uploading()).toBe(false)
  })

  test("a cancelled upload never inserts the part", async () => {
    const tracker = createPendingAttachmentTracker()
    const inserted: unknown[] = []
    let resolveUpload: (value: UploadedPromptAttachment) => void = () => {}

    const done = runPendingAttachmentUpload({
      file: fakeFile(),
      id: "prt-1",
      tracker,
      upload: () => new Promise<UploadedPromptAttachment>((resolve) => (resolveUpload = resolve)),
      insertAttachment: (part) => inserted.push(part),
      isDestinationCurrent: () => true,
    })

    tracker.cancel("prt-1")
    resolveUpload(uploadedResult)
    await done

    expect(inserted).toEqual([])
    expect(tracker.pending()).toEqual([])
  })

  test("a destination change drops the result without inserting", async () => {
    const tracker = createPendingAttachmentTracker()
    const inserted: unknown[] = []
    let current = false

    await runPendingAttachmentUpload({
      file: fakeFile(),
      id: "prt-1",
      tracker,
      upload: async () => uploadedResult,
      insertAttachment: (part) => inserted.push(part),
      isDestinationCurrent: () => current,
    })

    expect(inserted).toEqual([])
    expect(tracker.pending()).toEqual([])

    current = true
    await runPendingAttachmentUpload({
      file: fakeFile(),
      id: "prt-2",
      tracker,
      upload: async () => uploadedResult,
      insertAttachment: (part) => inserted.push(part),
      isDestinationCurrent: () => current,
    })

    expect(inserted.map((part) => (part as { id: string }).id)).toEqual(["prt-2"])
  })

  test("an upload failure clears the pending card and rethrows", async () => {
    const tracker = createPendingAttachmentTracker()
    tracker.begin({ id: "prt-warm", filename: "warm.png", mime: "image/png", size: 5 })

    await expect(
      runPendingAttachmentUpload({
        file: fakeFile("bad.png", "image/png", 32),
        id: "prt-1",
        tracker,
        upload: async () => {
          throw new Error("upload failed")
        },
        insertAttachment: () => {
          throw new Error("must not insert")
        },
        isDestinationCurrent: () => true,
      }),
    ).rejects.toThrow("upload failed")

    expect(tracker.pending()).toEqual([
      { id: "prt-warm", filename: "warm.png", mime: "image/png", size: 5, status: "uploading" },
    ])
    expect(tracker.uploading()).toBe(true)
  })
})

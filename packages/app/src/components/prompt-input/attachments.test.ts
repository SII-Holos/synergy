import { describe, expect, test } from "bun:test"
import type { UploadedAttachmentPart } from "@/context/prompt"
import { uploadedPromptAttachmentToFile } from "./attachment-files"
import { createUploadedAttachmentInputPart } from "./attachment-submit"

describe("prompt attachment presentation", () => {
  test("maps uploaded image attachments to AttachmentCard files with thumbnail metadata", () => {
    const attachment: UploadedAttachmentPart = {
      type: "attachment",
      id: "part-image",
      filename: "photo.jpg",
      mime: "image/jpeg",
      url: "asset://photo.jpg",
      size: 123,
      metadata: { thumbnail: { url: "asset://photo.thumb.webp" } },
      presentation: { renderer: "thumbnail", size: "small", crop: true },
    }

    expect(uploadedPromptAttachmentToFile(attachment)).toEqual({
      filename: "photo.jpg",
      mime: "image/jpeg",
      url: "asset://photo.jpg",
      size: 123,
      metadata: { thumbnail: { url: "asset://photo.thumb.webp" } },
      presentation: { renderer: "thumbnail", size: "small", crop: true },
    })
  })

  test("uses a small file card presentation for prompt-only non-image display", () => {
    const attachment: UploadedAttachmentPart = {
      type: "attachment",
      id: "part-doc",
      filename: "notes.txt",
      mime: "text/plain",
      url: "asset://notes.txt",
    }

    expect(uploadedPromptAttachmentToFile(attachment).presentation).toEqual({ renderer: "file", size: "small" })
  })
})

describe("prompt attachment submit parts", () => {
  test("keeps image uploads as provider-file asset attachments", () => {
    const part = createUploadedAttachmentInputPart({
      type: "attachment",
      id: "part-image",
      filename: "photo.jpg",
      mime: "image/jpeg",
      url: "asset://photo.jpg",
      metadata: { thumbnail: { url: "asset://photo.thumb.webp" } },
      presentation: { renderer: "thumbnail", size: "small", crop: true },
    })

    expect(part.url).toBe("asset://photo.jpg")
    expect(part.model).toEqual({ mode: "provider-file", summary: "photo.jpg (image/jpeg)" })
    expect(part.metadata).toEqual({ thumbnail: { url: "asset://photo.thumb.webp" } })
    expect(part.presentation).toEqual({ renderer: "thumbnail", size: "small", crop: true })
    expect(JSON.stringify(part)).not.toContain("data:")
  })

  test("keeps non-image uploads as summary asset attachments", () => {
    const part = createUploadedAttachmentInputPart({
      type: "attachment",
      id: "part-doc",
      filename: "notes.txt",
      mime: "text/plain",
      url: "asset://notes.txt",
    })

    expect(part.url).toBe("asset://notes.txt")
    expect(part.model).toEqual({ mode: "summary", summary: "notes.txt (text/plain)" })
    expect(JSON.stringify(part)).not.toContain("data:")
  })
})

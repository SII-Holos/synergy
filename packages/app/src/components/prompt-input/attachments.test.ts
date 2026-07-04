import { describe, expect, test } from "bun:test"
import type { UploadedAttachmentPart } from "@/context/prompt"
import { buildPromptUploadEntries } from "./attachment-preview"
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

describe("prompt attachment image preview grouping", () => {
  test("builds one preview group for uploaded images in attachment order", () => {
    const uploads: UploadedAttachmentPart[] = [
      {
        type: "attachment",
        id: "part-first-image",
        filename: "first.png",
        mime: "image/png",
        url: "asset://first.png",
        size: 100,
      },
      {
        type: "attachment",
        id: "part-doc",
        filename: "notes.txt",
        mime: "text/plain",
        url: "asset://notes.txt",
      },
      {
        type: "attachment",
        id: "part-second-image",
        filename: "second.jpg",
        mime: "image/jpeg",
        url: "asset://second.jpg",
        size: 200,
      },
    ]

    const entries = buildPromptUploadEntries("http://localhost:3000", uploads, (serverUrl, file, index) => {
      if (!file.mime.startsWith("image/")) return undefined
      const assetPath = file.url?.startsWith("asset://") ? `/asset/${file.url.slice(8)}` : file.url
      if (!assetPath) return undefined
      return {
        id: `${index}:${file.url}`,
        src: `${serverUrl}${assetPath}`,
        filename: file.filename ?? "image",
        mime: file.mime,
        size: file.size,
      }
    })
    const previewImages = entries.map((entry) => entry.imagePreview).filter(Boolean)

    expect(entries[0]?.imagePreviewIndex).toBe(0)
    expect(entries[1]?.imagePreviewIndex).toBeUndefined()
    expect(entries[2]?.imagePreviewIndex).toBe(1)
    expect(previewImages.map((image) => image?.filename)).toEqual(["first.png", "second.jpg"])
    expect(previewImages.map((image) => image?.src)).toEqual([
      "http://localhost:3000/asset/first.png",
      "http://localhost:3000/asset/second.jpg",
    ])
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

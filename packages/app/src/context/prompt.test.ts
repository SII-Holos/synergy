import { describe, expect, test } from "bun:test"
import { sanitizePromptValue } from "./prompt-sanitize"

describe("prompt sanitization", () => {
  test("removes legacy image parts and data URL attachments", () => {
    const prompt = sanitizePromptValue([
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "image",
        id: "legacy-image",
        filename: "legacy.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
      },
      {
        type: "attachment",
        id: "legacy-data-image",
        filename: "image.png",
        mime: "image/png",
        url: "data:image/png;base64,AAAA",
      },
      {
        type: "attachment",
        id: "legacy-data-pdf",
        filename: "document.pdf",
        mime: "application/pdf",
        url: "data:application/pdf;base64,AAAA",
      },
      {
        type: "attachment",
        id: "asset-image",
        filename: "image.png",
        mime: "image/png",
        url: "asset://image.png",
        metadata: { thumbnail: { url: "asset://thumb.webp" } },
        presentation: { renderer: "thumbnail", size: "small", crop: true },
      },
    ])

    expect(prompt).toEqual([
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "attachment",
        id: "asset-image",
        filename: "image.png",
        mime: "image/png",
        url: "asset://image.png",
        metadata: { thumbnail: { url: "asset://thumb.webp" } },
        presentation: { renderer: "thumbnail", size: "small", crop: true },
      },
    ])
    expect(JSON.stringify(prompt)).not.toContain("data:image")
  })
})

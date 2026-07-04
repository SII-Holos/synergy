import { describe, expect, test } from "bun:test"
import { sanitizePromptContextValue, sanitizePromptValue } from "./prompt-sanitize"

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

  test("sanitizes valid context items and drops invalid ones", () => {
    const context = sanitizePromptContextValue({
      activeTab: false,
      items: [
        { type: "file", path: "src/app.ts", selection: { startLine: 1, startChar: 2, endLine: 3, endChar: 4 } },
        { type: "file", path: "" },
        { type: "note", noteId: "nte_1" },
      ],
    })

    expect(context).toEqual({
      activeTab: false,
      items: [{ type: "file", path: "src/app.ts", selection: { startLine: 1, startChar: 2, endLine: 3, endChar: 4 } }],
    })
  })

  test("defaults malformed context to active tab with no explicit items", () => {
    expect(sanitizePromptContextValue("bad")).toEqual({ activeTab: true, items: [] })
  })
})

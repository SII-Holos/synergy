import { describe, expect, test } from "bun:test"
import { sanitizePromptContextValue, sanitizePromptValue } from "./sanitize"

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

  test("dropped file part with empty path", () => {
    const result = sanitizePromptValue([
      { type: "file", path: "", content: "", start: 0, end: 0 },
      { type: "text", content: "ok", start: 0, end: 2 },
    ])

    expect(result).toEqual([{ type: "text", content: "ok", start: 0, end: 2 }])
  })

  test("dropped session part missing required fields", () => {
    const result = sanitizePromptValue([
      { type: "session", id: "s1", title: "Partial" },
      { type: "text", content: "keep", start: 0, end: 4 },
    ])

    expect(result).toEqual([{ type: "text", content: "keep", start: 0, end: 4 }])
  })

  test("dropped note part missing noteId", () => {
    const result = sanitizePromptValue([
      { type: "note", id: "n1", title: "No Id" },
      { type: "text", content: "keep", start: 0, end: 4 },
    ])

    expect(result).toEqual([{ type: "text", content: "keep", start: 0, end: 4 }])
  })

  test("non-finite selection numbers are defaulted to 0", () => {
    const context = sanitizePromptContextValue({
      activeTab: false,
      items: [
        {
          type: "file",
          path: "src/bad.ts",
          selection: { startLine: NaN, startChar: Infinity, endLine: "bad" as unknown as number, endChar: 0 },
        },
      ],
    })

    expect(context).toEqual({
      activeTab: false,
      items: [{ type: "file", path: "src/bad.ts", selection: { startLine: 0, startChar: 0, endLine: 0, endChar: 0 } }],
    })
  })

  test("non-boolean activeTab defaults to true", () => {
    const context = sanitizePromptContextValue({ activeTab: "yes", items: [] })
    expect(context).toEqual({ activeTab: true, items: [] })
  })

  test("sanitizePromptValue defaults to empty text for completely invalid input", () => {
    expect(sanitizePromptValue(null)).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(sanitizePromptValue(undefined)).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(sanitizePromptValue([{ type: "unknown" }])).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("empty input array produces empty text", () => {
    expect(sanitizePromptValue([])).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("http and asset attachment URLs are preserved, data: are stripped", () => {
    const result = sanitizePromptValue([
      { type: "attachment", id: "http", url: "http://example.com/file", filename: "f", mime: "text/plain" },
      { type: "attachment", id: "https", url: "https://example.com/file", filename: "f", mime: "text/plain" },
      { type: "attachment", id: "asset", url: "asset://file", filename: "f", mime: "text/plain" },
      { type: "attachment", id: "data", url: "data:text/plain;base64,A", filename: "f", mime: "text/plain" },
      { type: "text", content: "go", start: 0, end: 2 },
    ])

    expect(result).toHaveLength(4)
    expect(result[0].id).toBe("http")
    expect(result[1].id).toBe("https")
    expect(result[2].id).toBe("asset")
    expect(result[3].type).toBe("text")
  })
})

import { describe, expect, test } from "bun:test"
import type { Part } from "@ericsanchezok/synergy-sdk"
import { createPromptDraftSnapshot, extractPromptDraft } from "./prompt"

const uploaded = {
  type: "attachment" as const,
  id: "upload-1",
  filename: "photo.jpg",
  mime: "image/jpeg",
  url: "asset://photo.jpg",
  metadata: { thumbnail: { url: "asset://photo.thumb.webp" } },
  presentation: { renderer: "thumbnail" as const, size: "small" as const, crop: true },
}

const note = {
  type: "note" as const,
  id: "note-1",
  noteId: "nte_1",
  title: "Plan",
  content: "note body",
}

const session = {
  type: "session" as const,
  id: "session-1",
  sessionId: "ses_1",
  directory: "/repo",
  title: "Prior session",
  updatedAt: 123,
}

describe("prompt draft restore", () => {
  test("restores valid prompt draft snapshots after sanitization", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [
        { type: "text", content: "hello ", start: 0, end: 6 },
        { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 6, end: 17 },
        uploaded,
        note,
        session,
      ],
      context: {
        activeTab: false,
        items: [
          { type: "file", path: "src/context.ts", selection: { startLine: 1, startChar: 0, endLine: 3, endChar: 0 } },
        ],
      },
    })

    const restored = extractPromptDraft({
      message: { metadata: { promptDraft: snapshot } },
      parts: [],
    })

    expect(restored).toEqual(snapshot)
    expect(restored).not.toBe(snapshot)
    expect(restored.prompt).not.toBe(snapshot.prompt)
    expect(restored.context.items).not.toBe(snapshot.context.items)
  })

  test("snapshot creation materializes active file context and disables active tab replay", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [{ type: "text", content: "use file", start: 0, end: 8 }],
      context: { activeTab: true, items: [] },
      activeFile: "src/current.ts",
    })

    expect(snapshot.context).toEqual({
      activeTab: false,
      items: [{ type: "file", path: "src/current.ts", selection: undefined }],
    })
  })

  test("snapshot creation preserves active tab when no active file exists", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [{ type: "text", content: "hello", start: 0, end: 5 }],
      context: { activeTab: true, items: [] },
    })

    expect(snapshot.context).toEqual({ activeTab: true, items: [] })
  })

  test("invalid prompt draft metadata falls back without throwing", () => {
    const restored = extractPromptDraft({
      message: { metadata: { promptDraft: { version: 2, prompt: "bad" } } },
      parts: [{ id: "text", type: "text", text: "legacy" } as Part],
    })

    expect(restored.prompt).toEqual([{ type: "text", content: "legacy", start: 0, end: 6 }])
    expect(restored.context).toEqual({ activeTab: true, items: [] })
  })

  test("legacy fallback restores text and inline file references", () => {
    const parts = [
      { id: "text", type: "text", text: "read @src/app.ts now" },
      {
        id: "file",
        type: "attachment",
        mime: "text/plain",
        url: "file:///repo/src/app.ts?start=10&end=12",
        filename: "app.ts",
        source: { type: "file", text: { value: "@src/app.ts", start: 5, end: 16 }, path: "/repo/src/app.ts" },
      },
    ] as Part[]

    const restored = extractPromptDraft({ parts, directory: "/repo" })

    expect(restored.prompt).toEqual([
      { type: "text", content: "read ", start: 0, end: 5 },
      {
        type: "file",
        path: "src/app.ts",
        content: "@src/app.ts",
        start: 5,
        end: 16,
        selection: { startLine: 10, endLine: 12, startChar: 0, endChar: 0 },
      },
      { type: "text", content: " now", start: 16, end: 20 },
    ])
  })

  test("legacy fallback restores asset uploads with metadata and presentation", () => {
    const restored = extractPromptDraft({
      parts: [
        {
          id: "asset",
          type: "attachment",
          mime: "image/jpeg",
          url: "asset://photo.jpg",
          filename: "photo.jpg",
          metadata: { thumbnail: { url: "asset://photo.thumb.webp" } },
          presentation: { renderer: "thumbnail", size: "small", crop: true },
        } as unknown as Part,
      ],
    })

    expect(restored.prompt).toEqual([
      { type: "text", content: "", start: 0, end: 0 },
      { ...uploaded, id: "asset" },
    ])
  })

  test("legacy fallback restores session attachments from metadata", () => {
    const restored = extractPromptDraft({
      parts: [
        {
          id: "session-part",
          type: "attachment",
          mime: "text/plain",
          url: "data:text/plain;base64,abc",
          filename: "session.session.txt",
          metadata: { kind: "session", sessionId: "ses_2", directory: "/repo", title: "Session", updatedAt: 456 },
        } as unknown as Part,
      ],
    })

    expect(restored.prompt).toEqual([
      { type: "text", content: "", start: 0, end: 0 },
      { type: "session", id: "session-part", sessionId: "ses_2", directory: "/repo", title: "Session", updatedAt: 456 },
    ])
  })

  test("legacy fallback skips data note attachments without a snapshot", () => {
    const restored = extractPromptDraft({
      parts: [
        {
          id: "note-part",
          type: "attachment",
          mime: "text/plain",
          url: "data:text/plain;base64,abc",
          filename: "note.md",
          metadata: { kind: "note", noteId: "nte_1", title: "Note" },
        } as unknown as Part,
      ],
    })

    expect(restored.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("legacy fallback restores parseable file URLs as deduplicated explicit context", () => {
    const parts = [
      {
        id: "ctx-1",
        type: "attachment",
        mime: "text/plain",
        url: "file:///repo/src/context.ts?start=2&end=4",
        filename: "context.ts",
      },
      {
        id: "ctx-2",
        type: "attachment",
        mime: "text/plain",
        url: "file:///repo/src/context.ts?start=2&end=4",
        filename: "context.ts",
      },
    ] as Part[]

    const restored = extractPromptDraft({ parts, directory: "/repo" })

    expect(restored.context).toEqual({
      activeTab: false,
      items: [
        { type: "file", path: "src/context.ts", selection: { startLine: 2, endLine: 4, startChar: 0, endChar: 0 } },
      ],
    })
  })
})

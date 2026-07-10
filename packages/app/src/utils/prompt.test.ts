import { describe, expect, test } from "bun:test"
import type { Part } from "@ericsanchezok/synergy-sdk"
import {
  createPromptDraftSnapshot,
  createSubmitFailureRestoreSnapshot,
  extractPromptDraft,
  type PromptDraftSnapshot,
} from "./prompt"

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

  test("submit failure restore preserves explicit file context", () => {
    const failureSnapshot = createSubmitFailureRestoreSnapshot({
      prompt: [{ type: "text", content: "use file", start: 0, end: 8 }],
      context: { items: [{ type: "file", path: "src/current.ts" }] },
    })

    expect(failureSnapshot.context).toEqual({ items: [{ type: "file", path: "src/current.ts", selection: undefined }] })
  })

  test("invalid prompt draft metadata falls back without throwing", () => {
    const restored = extractPromptDraft({
      message: { metadata: { promptDraft: { version: 2, prompt: "bad" } } },
      parts: [{ id: "text", type: "text", text: "legacy" } as Part],
    })

    expect(restored.prompt).toEqual([{ type: "text", content: "legacy", start: 0, end: 6 }])
    expect(restored.context).toEqual({ items: [] })
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
      items: [
        { type: "file", path: "src/context.ts", selection: { startLine: 2, endLine: 4, startChar: 0, endChar: 0 } },
      ],
    })
  })

  test("falls back to legacy when message has no metadata", () => {
    const restored = extractPromptDraft({
      parts: [{ id: "text", type: "text", text: "plain text" } as Part],
    })

    expect(restored.prompt).toEqual([{ type: "text", content: "plain text", start: 0, end: 10 }])
    expect(restored.context).toEqual({ items: [] })
  })

  test("falls back to legacy when metadata has no promptDraft key", () => {
    const restored = extractPromptDraft({
      message: { metadata: { unrelated: "value" } },
      parts: [{ id: "text", type: "text", text: "no draft" } as Part],
    })

    expect(restored.prompt).toEqual([{ type: "text", content: "no draft", start: 0, end: 8 }])
    expect(restored.context).toEqual({ items: [] })
  })

  test("snapshot dedup: same file with same selection from context items is collapsed", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [{ type: "text", content: "dup", start: 0, end: 3 }],
      context: {
        items: [
          { type: "file", path: "src/app.ts", selection: { startLine: 5, startChar: 0, endLine: 10, endChar: 0 } },
          { type: "file", path: "src/app.ts", selection: { startLine: 5, startChar: 0, endLine: 10, endChar: 0 } },
        ],
      },
    })

    expect(snapshot.context.items).toHaveLength(1)
  })

  test("snapshot sanitize strips prompt parts with dangerous shapes", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [
        { type: "text", content: "safe", start: 0, end: 4 },
        { type: "evil", payload: "malicious" } as unknown as never,
      ],
      context: { items: [] },
    })

    expect(snapshot.prompt).toEqual([{ type: "text", content: "safe", start: 0, end: 4 }])
  })

  test("snapshot with note and session parts round-trips through extractPromptDraft", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [{ type: "text", content: "doc", start: 0, end: 3 }, note, session],
      context: { items: [] },
    })

    const restored = extractPromptDraft({
      message: { metadata: { promptDraft: snapshot } },
      parts: [],
    })

    expect(restored.prompt).toHaveLength(3)
    expect(restored.prompt[1]).toEqual(note)
    expect(restored.prompt[2]).toEqual(session)
  })

  test("legacy fallback: text position mismatch triggers search reposition", () => {
    const parts = [
      { id: "text", type: "text", text: "read @src/app.ts and check" },
      {
        id: "file",
        type: "attachment",
        mime: "text/plain",
        url: "file:///repo/src/app.ts",
        filename: "app.ts",
        source: {
          type: "file",
          text: { value: "@src/app.ts", start: 999, end: 1010 },
          path: "/repo/src/app.ts",
        },
      },
    ] as Part[]

    const restored = extractPromptDraft({ parts, directory: "/repo" })

    expect(restored.prompt).toHaveLength(3)
    expect(restored.prompt[0].type).toBe("text")
    expect(restored.prompt[1].type).toBe("file")
    expect((restored.prompt[1] as { path: string }).path).toBe("src/app.ts")
  })

  test("legacy fallback: empty parts array produces empty prompt", () => {
    const restored = extractPromptDraft({ parts: [] })

    expect(restored.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(restored.context).toEqual({ items: [] })
  })

  test("legacy fallback: no text part, only asset attachments", () => {
    const parts = [
      {
        id: "img",
        type: "attachment",
        mime: "image/png",
        url: "asset://img.png",
        filename: "image.png",
      },
    ] as Part[]

    const restored = extractPromptDraft({ parts })

    expect(restored.prompt).toEqual([
      { type: "text", content: "", start: 0, end: 0 },
      { type: "attachment", id: "img", filename: "image.png", mime: "image/png", url: "asset://img.png" },
    ])
  })

  test("legacy fallback: session attachment missing sessionId is skipped", () => {
    const parts = [
      {
        id: "bad-session",
        type: "attachment",
        mime: "text/plain",
        url: "data:text/plain;base64,abc",
        filename: "session.txt",
        metadata: { kind: "session", title: "No ID" },
      },
    ] as unknown as Part[]

    const restored = extractPromptDraft({ parts })

    expect(restored.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("legacy fallback: inline file + file context URL for same content dedups", () => {
    const parts = [
      { id: "text", type: "text", text: "check @src/app.ts" },
      {
        id: "inline-source",
        type: "attachment",
        mime: "text/plain",
        url: "file:///repo/src/app.ts?start=1&end=5",
        filename: "app.ts",
        source: { type: "file", text: { value: "@src/app.ts", start: 6, end: 17 }, path: "/repo/src/app.ts" },
      },
    ] as Part[]

    const restored = extractPromptDraft({ parts, directory: "/repo" })

    expect(restored.prompt.some((p) => p.type === "file")).toBe(true)
  })

  test("extractPromptDraft preserves explicit context items", () => {
    const snapshot = createPromptDraftSnapshot({
      prompt: [{ type: "text", content: "multi context", start: 0, end: 13 }],
      context: {
        items: [
          { type: "file", path: "src/a.ts" },
          { type: "file", path: "src/b.ts" },
        ],
      },
    })

    const restored = extractPromptDraft({
      message: { metadata: { promptDraft: snapshot } },
      parts: [],
    })

    expect(restored.context.items).toHaveLength(2)
    expect(restored.context.items[0].path).toBe("src/a.ts")
    expect(restored.context.items[1].path).toBe("src/b.ts")
  })

  test("legacy fallback: http attachment without text content", () => {
    const restored = extractPromptDraft({
      parts: [
        { id: "text", type: "text", text: "see " },
        {
          id: "web",
          type: "attachment",
          mime: "text/html",
          url: "https://example.com/doc",
          filename: "doc.html",
        },
      ] as Part[],
    })

    expect(restored.prompt).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "attachment", id: "web", filename: "doc.html", mime: "text/html", url: "https://example.com/doc" },
    ])
  })
})

import { describe, expect, test } from "bun:test"
import {
  isActiveMediaGenerationToolPart,
  isArtifactOnlyToolPart,
  isPromotedToolResultPart,
  primaryToolAttachments,
  shouldHideToolPart,
  toolResultPresentation,
} from "./tool-result-presentation"

const image = {
  id: "part-image",
  sessionID: "session",
  messageID: "message",
  type: "file" as const,
  mime: "image/svg+xml",
  filename: "meme.svg",
  url: "asset://meme",
}

const text = {
  id: "part-text",
  sessionID: "session",
  messageID: "message",
  type: "file" as const,
  mime: "text/plain",
  filename: "notes.txt",
  url: "asset://notes",
}

describe("tool result presentation", () => {
  test("detects completed artifact-only tools with attachments", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: { display: { presentation: "artifact-only" } },
        attachments: [image],
      },
    }

    expect(toolResultPresentation(part)).toBe("artifact-only")
    expect(isArtifactOnlyToolPart(part)).toBe(true)
  })

  test("does not hide running or empty artifact-only tools", () => {
    expect(
      isArtifactOnlyToolPart({
        type: "tool",
        state: {
          status: "running",
          metadata: { display: { presentation: "artifact-only" } },
          attachments: [image],
        },
      }),
    ).toBe(false)

    expect(
      isArtifactOnlyToolPart({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { presentation: "artifact-only" } },
          attachments: [],
        },
      }),
    ).toBe(false)
  })

  test("selects primary attachments when ids are present", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: { display: { presentation: "artifact-only", primaryAttachmentIds: ["part-image"] } },
        attachments: [text, image],
      },
    }

    expect(primaryToolAttachments(part)).toEqual([image])
  })

  test("falls back to all attachments when primary ids do not match", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: { display: { presentation: "artifact-only", primaryAttachmentIds: ["missing"] } },
        attachments: [text, image],
      },
    }

    expect(primaryToolAttachments(part)).toEqual([text, image])
  })

  test("hides active media-generation tools for the dedicated media surface", () => {
    const part = {
      type: "tool",
      state: {
        status: "running",
        input: { prompt: "make a meme" },
        metadata: {
          display: {
            kind: "media-generation",
            visibility: "media",
            media: { type: "image" },
          },
        },
      },
    }

    expect(isActiveMediaGenerationToolPart(part)).toBe(true)
    expect(shouldHideToolPart(part)).toBe(true)
  })

  test("promotes completed media-generation attachments", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: {
          display: {
            kind: "media-generation",
            visibility: "media",
            presentation: "artifact-only",
          },
        },
        attachments: [image],
      },
    }

    expect(isPromotedToolResultPart(part)).toBe(true)
    expect(shouldHideToolPart(part)).toBe(true)
    expect(primaryToolAttachments(part)).toEqual([image])
  })

  test("does not hide media-generation errors or completed media without attachments", () => {
    expect(
      shouldHideToolPart({
        type: "tool",
        state: {
          status: "error",
          metadata: { display: { kind: "media-generation", visibility: "media" } },
          error: "failed",
        },
      }),
    ).toBe(false)

    expect(
      shouldHideToolPart({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation", visibility: "media" } },
          attachments: [],
        },
      }),
    ).toBe(false)
  })
})

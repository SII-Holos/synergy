import { describe, expect, test } from "bun:test"
import {
  isActiveMediaGenerationToolPart,
  isAttachmentOnlyToolPart,
  isPromotedToolResultPart,
  isToolCardHidden,
  primaryToolAttachments,
  toolResultPresentation,
} from "./tool-result-presentation"

const image = {
  id: "part-image",
  sessionID: "session",
  messageID: "message",
  type: "attachment" as const,
  mime: "image/svg+xml",
  filename: "meme.svg",
  url: "asset://meme",
}

const text = {
  id: "part-text",
  sessionID: "session",
  messageID: "message",
  type: "attachment" as const,
  mime: "text/plain",
  filename: "notes.txt",
  url: "asset://notes",
}

describe("tool result presentation", () => {
  test("detects completed attachment-only tools with attachments", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: { display: { presentation: "attachment-only" } },
        attachments: [image],
      },
    }

    expect(toolResultPresentation(part)).toBe("attachment-only")
    expect(isAttachmentOnlyToolPart(part)).toBe(true)
  })

  test("does not hide running or empty attachment-only tools", () => {
    expect(
      isAttachmentOnlyToolPart({
        type: "tool",
        state: {
          status: "running",
          metadata: { display: { presentation: "attachment-only" } },
          attachments: [image],
        },
      }),
    ).toBe(false)

    expect(
      isAttachmentOnlyToolPart({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { presentation: "attachment-only" } },
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
        metadata: { display: { presentation: "attachment-only", primaryAttachmentIds: ["part-image"] } },
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
        metadata: { display: { presentation: "attachment-only", primaryAttachmentIds: ["missing"] } },
        attachments: [text, image],
      },
    }

    expect(primaryToolAttachments(part)).toEqual([text, image])
  })

  test("detects active media-generation tools for the timeline placeholder", () => {
    for (const status of ["pending", "generating", "running"]) {
      const part = {
        type: "tool",
        state: {
          status,
          input: { prompt: "make a meme" },
          metadata: {
            display: {
              kind: "media-generation",
              media: { type: "image" },
            },
          },
        },
      }

      expect(isActiveMediaGenerationToolPart(part)).toBe(true)
    }
  })

  test("promotes completed media-generation attachments", () => {
    const part = {
      type: "tool",
      state: {
        status: "completed",
        metadata: {
          display: {
            kind: "media-generation",
            presentation: "attachment-only",
          },
        },
        attachments: [image],
      },
    }

    expect(isPromotedToolResultPart(part)).toBe(true)
    expect(primaryToolAttachments(part)).toEqual([image])
  })

  test("does not promote media-generation errors or completed media without attachments", () => {
    expect(
      isPromotedToolResultPart({
        type: "tool",
        state: {
          status: "error",
          metadata: { display: { kind: "media-generation" } },
          error: "failed",
        },
      }),
    ).toBe(false)

    expect(
      isPromotedToolResultPart({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation" } },
          attachments: [],
        },
      }),
    ).toBe(false)
  })

  test("detects explicit hidden tool cards", () => {
    expect(
      isToolCardHidden({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
        },
      }),
    ).toBe(true)

    expect(
      isToolCardHidden({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation" } },
        },
      }),
    ).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import {
  isMediaGenerationToolPart,
  isToolCardHidden,
  toolDisplayMetadata,
} from "../../src/components/tool-result-presentation"

describe("tool result display metadata", () => {
  test("reads declarative display metadata from tool state", () => {
    const display = {
      kind: "media-generation" as const,
      toolCard: "hidden" as const,
      media: { type: "image" as const, aspectRatio: "1:1" as const, size: "small" as const },
    }

    expect(
      toolDisplayMetadata({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display },
        },
      }),
    ).toEqual(display)
  })

  test("recognizes declarative media generation throughout its lifecycle", () => {
    for (const status of ["pending", "generating", "running", "completed", "error"]) {
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

      expect(isMediaGenerationToolPart(part)).toBe(true)
    }
  })

  test("detects explicit hidden tool cards only", () => {
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

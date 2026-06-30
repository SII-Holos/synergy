import { describe, expect, test } from "bun:test"
import { isActiveMediaGenerationToolPart, isToolCardHidden, toolDisplayMetadata } from "./tool-result-presentation"

describe("tool result display metadata", () => {
  test("reads declarative display metadata from tool state", () => {
    const display = {
      kind: "media-generation" as const,
      toolCard: "hidden" as const,
      media: { type: "image" as const, aspectRatio: "1:1" as const },
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

  test("detects active media-generation tools for pending placeholders", () => {
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

  test("does not treat completed or error media tools as active placeholders", () => {
    for (const status of ["completed", "error"]) {
      expect(
        isActiveMediaGenerationToolPart({
          type: "tool",
          state: {
            status,
            metadata: { display: { kind: "media-generation" } },
          },
        }),
      ).toBe(false)
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

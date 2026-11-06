import { describe, expect, test } from "bun:test"
import { streamingTokenReceipt } from "../../src/context/streaming-token-event"

describe("streamingTokenReceipt", () => {
  test("measures projected deltas and their first body checkpoint without counting historical bodies", () => {
    const summary = { id: "part", sessionID: "session", messageID: "message", type: "text" }
    expect(
      streamingTokenReceipt({
        type: "message.part.summary",
        properties: { summary, content: { kind: "delta", delta: "new", baseVersion: "old" } },
      }),
    ).toEqual({ part: summary, delta: "new" })
    expect(
      streamingTokenReceipt({
        type: "message.part.summary",
        properties: {
          summary,
          content: { kind: "checkpoint", part: { ...summary, text: "whole body" } },
          delta: "first",
        },
      }),
    ).toEqual({ part: summary, delta: "first" })
    expect(
      streamingTokenReceipt({
        type: "message.part.summary",
        properties: { summary, content: { kind: "checkpoint", part: { ...summary, text: "history" } } },
      }),
    ).toBeUndefined()
  })
  test("normalizes compact delta frames for browser timing", () => {
    expect(
      streamingTokenReceipt({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "part_1",
          kind: "text",
          delta: "hello",
        },
      }),
    ).toEqual({
      part: { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
      delta: "hello",
    })
  })

  test("normalizes full streaming checkpoints and ignores terminal updates", () => {
    const part = { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "reasoning" }

    expect(
      streamingTokenReceipt({
        type: "message.part.updated",
        properties: { part, delta: "next" },
      }),
    ).toEqual({ part, delta: "next" })
    expect(
      streamingTokenReceipt({
        type: "message.part.updated",
        properties: { part },
      }),
    ).toBeUndefined()
  })
})

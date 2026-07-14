import { describe, expect, test } from "bun:test"
import { streamingTokenReceipt } from "./streaming-token-event"

describe("streamingTokenReceipt", () => {
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

import { describe, expect, test } from "bun:test"
import { resolveFinalResponseText } from "../../src/channel/response-text"
import type { MessageV2 } from "../../src/session/message-v2"

describe("Channel final response text", () => {
  test("uses the terminal assistant response instead of accumulated progress", () => {
    const transcript = new Map([
      ["progress-1", "first progress update"],
      ["progress-2", "second progress update"],
    ])
    const terminalParts = [{ type: "text", text: "final answer" }] as MessageV2.Part[]

    expect(resolveFinalResponseText(transcript, terminalParts)).toBe("final answer")
  })

  test("falls back to accumulated progress when no terminal text exists", () => {
    const transcript = new Map([
      ["progress-1", "first progress update"],
      ["progress-2", "second progress update"],
    ])

    expect(resolveFinalResponseText(transcript, [])).toBe("first progress update\n\nsecond progress update")
  })
})

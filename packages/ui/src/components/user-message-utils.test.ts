import { describe, expect, test } from "bun:test"
import type { Part as PartType } from "@ericsanchezok/synergy-sdk"
import {
  USER_MESSAGE_COLLAPSE_LENGTH,
  USER_MESSAGE_COLLAPSE_LINES,
  shouldCollapseUserMessage,
  userMessageLineCount,
  visibleUserMessageText,
} from "./user-message-utils"

describe("user message display helpers", () => {
  test("collapses only long or many-line messages", () => {
    expect(shouldCollapseUserMessage("short message")).toBe(false)
    expect(shouldCollapseUserMessage("x".repeat(USER_MESSAGE_COLLAPSE_LENGTH))).toBe(false)
    expect(shouldCollapseUserMessage("x".repeat(USER_MESSAGE_COLLAPSE_LENGTH + 1))).toBe(true)

    const compactLines = Array.from({ length: USER_MESSAGE_COLLAPSE_LINES }, () => "line").join("\n")
    const expandedLines = Array.from({ length: USER_MESSAGE_COLLAPSE_LINES + 1 }, () => "line").join("\n")
    expect(userMessageLineCount(compactLines)).toBe(USER_MESSAGE_COLLAPSE_LINES)
    expect(shouldCollapseUserMessage(compactLines)).toBe(false)
    expect(shouldCollapseUserMessage(expandedLines)).toBe(true)
  })

  test("uses the first non-synthetic text part as the copyable user text", () => {
    const parts = [
      { type: "text", text: "hidden", synthetic: true },
      { type: "attachment", filename: "image.png", mime: "image/png" },
      { type: "text", text: "visible user message" },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("visible user message")
  })
})

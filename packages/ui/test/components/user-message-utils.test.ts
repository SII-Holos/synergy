import { describe, expect, test } from "bun:test"
import type { Part as PartType } from "@ericsanchezok/synergy-sdk"
import {
  USER_MESSAGE_COLLAPSE_LENGTH,
  hasVisibleUserMessageContent,
  USER_MESSAGE_COLLAPSE_LINES,
  shouldCollapseUserMessage,
  userMessageLineCount,
  visibleUserMessageText,
} from "../../src/components/user-message-utils"

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

  test("restores inline file text omitted by legacy prompt submission", () => {
    const parts = [
      { type: "text", text: "Read  now" },
      {
        type: "attachment",
        filename: "app.ts",
        mime: "text/plain",
        source: {
          type: "file",
          text: { value: "@src/app.ts", start: 5, end: 16 },
          path: "/repo/src/app.ts",
        },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("Read @src/app.ts now")
  })

  test("keeps complete inline file text unchanged", () => {
    const parts = [
      { type: "text", text: "Read @src/app.ts now" },
      {
        type: "attachment",
        filename: "app.ts",
        mime: "text/plain",
        source: {
          type: "file",
          text: { value: "@src/app.ts", start: 5, end: 16 },
          path: "/repo/src/app.ts",
        },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("Read @src/app.ts now")
  })

  test("keeps complete inline file text unchanged when stored coordinates are offset", () => {
    const parts = [
      { type: "text", text: "xRead @src/app.ts now" },
      {
        type: "attachment",
        filename: "app.ts",
        mime: "text/plain",
        source: {
          type: "file",
          text: { value: "@src/app.ts", start: 5, end: 16 },
          path: "/repo/src/app.ts",
        },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("xRead @src/app.ts now")
  })

  test("restores a mention-only user message from its file attachment", () => {
    const parts = [
      { type: "text", text: "" },
      {
        type: "attachment",
        filename: "app.ts",
        mime: "text/plain",
        source: {
          type: "file",
          text: { value: "@src/app.ts", start: 0, end: 11 },
          path: "/repo/src/app.ts",
        },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("@src/app.ts")
  })

  test("restores multiple omitted inline file references in coordinate order", () => {
    const parts = [
      { type: "text", text: "Read  then  done" },
      {
        type: "attachment",
        mime: "text/plain",
        source: { type: "file", text: { value: "@src/a.ts", start: 5, end: 14 }, path: "/repo/src/a.ts" },
      },
      {
        type: "attachment",
        mime: "text/plain",
        source: { type: "file", text: { value: "@src/b.ts", start: 20, end: 29 }, path: "/repo/src/b.ts" },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("Read @src/a.ts then @src/b.ts done")
  })

  test("leaves text unchanged when inline file coordinates cannot be recovered safely", () => {
    const parts = [
      { type: "text", text: "Keep this text" },
      {
        type: "attachment",
        mime: "text/plain",
        source: { type: "file", text: { value: "@src/app.ts", start: 999, end: 1010 }, path: "/repo/src/app.ts" },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("Keep this text")
  })

  test("leaves text unchanged when any inline file reference is malformed", () => {
    const parts = [
      { type: "text", text: "Read  then  done" },
      {
        type: "attachment",
        mime: "text/plain",
        source: { type: "file", text: { value: "@src/a.ts", start: 5, end: 14 }, path: "/repo/src/a.ts" },
      },
      {
        type: "attachment",
        mime: "text/plain",
        source: { type: "file", text: { value: "@src/b.ts", start: 20, end: 20 }, path: "/repo/src/b.ts" },
      },
    ] as PartType[]

    expect(visibleUserMessageText(parts)).toBe("Read  then  done")
  })

  test("does not treat synthetic-only text as visible user content", () => {
    expect(hasVisibleUserMessageContent(undefined)).toBe(false)
    expect(
      hasVisibleUserMessageContent([
        { type: "text", text: "Continue if you have next steps", synthetic: true },
      ] as PartType[]),
    ).toBe(false)
    expect(hasVisibleUserMessageContent([{ type: "text", text: "visible user message" }] as PartType[])).toBe(true)
    expect(
      hasVisibleUserMessageContent([{ type: "attachment", filename: "image.png", mime: "image/png" }] as PartType[]),
    ).toBe(true)
  })
})

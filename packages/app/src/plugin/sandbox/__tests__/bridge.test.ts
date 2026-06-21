import { describe, expect, test } from "bun:test"
import { parseBridgeMessage, isValidOrigin } from "../postmessage-bridge"

describe("parseBridgeMessage", () => {
  test("accepts valid message types", () => {
    const messages: { type: string; [key: string]: unknown }[] = [
      { type: "plugin.ready" },
      { type: "plugin.init", payload: { config: {}, theme: "dark" } },
      { type: "plugin.action", id: "action-1", payload: { key: "value" } },
      { type: "host.action", id: "host-action-1", payload: null },
      { type: "plugin.resize", payload: { width: 800, height: 600 } },
      { type: "plugin.toast", payload: { message: "Hello" } },
      { type: "plugin.error", payload: { message: "Something went wrong", code: "E001" } },
    ]

    for (const msg of messages) {
      const result = parseBridgeMessage(msg)
      expect(result).not.toBeNull()
      expect(result!.type as string).toBe(msg.type)
    }
  })

  test("rejects null", () => {
    expect(parseBridgeMessage(null)).toBeNull()
  })

  test("rejects undefined", () => {
    expect(parseBridgeMessage(undefined)).toBeNull()
  })

  test("rejects non-object primitives", () => {
    expect(parseBridgeMessage(42)).toBeNull()
    expect(parseBridgeMessage("hello")).toBeNull()
    expect(parseBridgeMessage(true)).toBeNull()
  })

  test("rejects arrays", () => {
    expect(parseBridgeMessage([{ type: "plugin.ready" }])).toBeNull()
  })

  test("rejects unknown message type", () => {
    expect(parseBridgeMessage({ type: "unknown.type" })).toBeNull()
    expect(parseBridgeMessage({ type: "plugin.fake" })).toBeNull()
    expect(parseBridgeMessage({ type: "" })).toBeNull()
  })

  test("rejects missing type field", () => {
    expect(parseBridgeMessage({})).toBeNull()
    expect(parseBridgeMessage({ payload: {} })).toBeNull()
    expect(parseBridgeMessage({ type: undefined })).toBeNull()
  })

  test("rejects non-string type field", () => {
    expect(parseBridgeMessage({ type: 42 })).toBeNull()
    expect(parseBridgeMessage({ type: true })).toBeNull()
    expect(parseBridgeMessage({ type: null })).toBeNull()
  })
})

describe("isValidOrigin", () => {
  const hostOrigin = "https://example.com"

  test("accepts host origin", () => {
    expect(isValidOrigin("https://example.com", hostOrigin)).toBe(true)
  })

  test("accepts opaque sandbox origin", () => {
    expect(isValidOrigin("null", hostOrigin)).toBe(true)
  })

  test("rejects cross-origin strings", () => {
    expect(isValidOrigin("https://evil.com", hostOrigin)).toBe(false)
    expect(isValidOrigin("http://example.com", hostOrigin)).toBe(false)
    expect(isValidOrigin("https://example.com:4443", hostOrigin)).toBe(false)
  })

  test("rejects empty origin", () => {
    expect(isValidOrigin("", hostOrigin)).toBe(false)
  })
})

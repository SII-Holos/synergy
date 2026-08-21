import { describe, expect, test } from "bun:test"

import { messageCreatedTime } from "../../src/components/message-time"

describe("messageCreatedTime", () => {
  test("freezes the formatted result per minute bucket", () => {
    const desc = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!
    let calls = 0
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
      configurable: true,
      get() {
        calls++
        return desc.get!.call(this)
      },
    })
    try {
      const base = Date.UTC(2026, 0, 15, 14, 30, 0)
      const first = messageCreatedTime(base + 1_000)
      expect(messageCreatedTime(base + 59_000)).toBe(first)
      expect(messageCreatedTime(base + 2_000)).toBe(first)
      expect(calls).toBe(1)

      const nextMinute = messageCreatedTime(base + 61_000)
      expect(nextMinute).not.toBe(first)
      expect(calls).toBe(2)
    } finally {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "format", desc)
    }
  })

  test("returns undefined for a missing timestamp", () => {
    expect(messageCreatedTime(undefined)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { nextMessageWindowTotal } from "./session-message-total"

describe("session message window total", () => {
  test("increments only when a new message enters the visible window", () => {
    expect(nextMessageWindowTotal({ total: 10, existing: false, visible: true })).toBe(11)
  })

  test("does not increment for repeated updates or history-window misses", () => {
    expect(nextMessageWindowTotal({ total: 10, existing: true, visible: true })).toBe(10)
    expect(nextMessageWindowTotal({ total: 10, existing: false, visible: false })).toBe(10)
  })
})

import { describe, expect, test } from "bun:test"
import { nextMessageWindowTotal, nextMessageWindowTotalAfterRemoval } from "./session-message-total"

describe("session message window total", () => {
  test("increments only when a new message enters the visible window", () => {
    expect(nextMessageWindowTotal({ total: 10, existing: false, visible: true })).toBe(11)
  })

  test("does not increment for repeated updates or history-window misses", () => {
    expect(nextMessageWindowTotal({ total: 10, existing: true, visible: true })).toBe(10)
    expect(nextMessageWindowTotal({ total: 10, existing: false, visible: false })).toBe(10)
  })

  test("does not decrement for an unseen pending message that was never counted", () => {
    expect(nextMessageWindowTotalAfterRemoval({ total: 10, pending: true })).toBe(10)
  })

  test("decrements counted removals without going below zero", () => {
    expect(nextMessageWindowTotalAfterRemoval({ total: 10, pending: false })).toBe(9)
    expect(nextMessageWindowTotalAfterRemoval({ total: 0, pending: false })).toBe(0)
  })
})

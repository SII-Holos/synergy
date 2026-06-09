import { describe, expect, test } from "bun:test"
import { isNewSessionView } from "./session-state"

describe("isNewSessionView", () => {
  test("shows the new-session input while resolving the hosted home route", () => {
    expect(
      isNewSessionView({
        hasSessionId: false,
        resolvingHome: true,
        isGlobal: true,
        messageCount: 0,
      }),
    ).toBe(true)
  })

  test("treats empty global sessions as new sessions", () => {
    expect(
      isNewSessionView({
        hasSessionId: true,
        resolvingHome: false,
        isGlobal: true,
        messageCount: 0,
      }),
    ).toBe(true)
  })

  test("keeps non-empty sessions in conversation mode", () => {
    expect(
      isNewSessionView({
        hasSessionId: true,
        resolvingHome: false,
        isGlobal: true,
        messageCount: 1,
      }),
    ).toBe(false)
  })
})

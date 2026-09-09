import { describe, expect, test } from "bun:test"
import { resolveNotificationEvent } from "../../src/context/notification-event"
const copy = {
  responseReady: "Response ready",
  sessionError: "Session error",
  errorFallback: "An error occurred",
}

describe("notification event semantics", () => {
  test("does not interpret lifecycle idle as a completed response", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.idle", properties: { sessionID: "ses_a" } },
        copy,
      }),
    ).toBeUndefined()
  })

  test("turn completion follows the durable completion notice event", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.completion", properties: { sessionID: "ses_a", unreadCount: 2 } },
        session: { id: "ses_a", title: "Build finished" },
        copy,
      }),
    ).toEqual({
      type: "turn-complete",
      sessionID: "ses_a",
      title: "Response ready",
      description: "Build finished",
      href: "/L3Byb2plY3Q/session/ses_a",
    })
  })

  test("does not raise global completion notifications for child sessions", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.completion", properties: { sessionID: "ses_child", unreadCount: 1 } },
        session: { id: "ses_child", title: "Child", parentID: "ses_parent" },
        copy,
      }),
    ).toBeUndefined()
  })

  test("keeps session errors distinct from completion", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.error", properties: { sessionID: "ses_a", error: "boom" } },
        session: { id: "ses_a", title: "Build" },
        copy,
      }),
    ).toEqual({
      type: "error",
      sessionID: "ses_a",
      error: "boom",
      title: "Session error",
      description: "Build",
      href: "/L3Byb2plY3Q/session/ses_a",
    })
  })
})

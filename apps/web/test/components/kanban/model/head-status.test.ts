import { describe, expect, test } from "bun:test"
import {
  paneDisplayState,
  paneHeadStatusFromVisual,
  type PaneHeadStatus,
} from "../../../../src/components/kanban/model/head-status"

describe("paneHeadStatusFromVisual", () => {
  test("resting pane state describes activity rather than repeating its Scope", () => {
    const state = {
      icon: "house" as const,
      label: { id: "session.state.home", message: "Home session" },
      tone: "default" as const,
    }
    expect(paneDisplayState(state).label.id).toBe("app.kanban.status.idle")
    expect(paneDisplayState({ ...state, completionUnread: true }).label.id).toBe("app.kanban.responseReady")
    const waiting = {
      ...state,
      tone: "waiting" as const,
      label: { id: "session.state.waiting", message: "Waiting for you" },
    }
    expect(paneDisplayState(waiting)).toBe(waiting)
  })
  test("active and blueprint-running tones read as working", () => {
    expect(paneHeadStatusFromVisual({ tone: "active", pulse: true })).toBe("working")
    expect(paneHeadStatusFromVisual({ tone: "blueprint-running", pulse: true })).toBe("working")
  })

  test("retry status reads as working even when the tone is idle", () => {
    expect(paneHeadStatusFromVisual({ statusType: "retry", tone: "default" })).toBe("working")
  })

  test("an audit recolored to a paused status stops reading as working", () => {
    expect(paneHeadStatusFromVisual({ statusType: "paused", tone: "blueprint-audit", completionUnread: true })).toBe(
      "completed",
    )
  })

  test("waiting and blueprint-waiting tones read as waiting", () => {
    expect(paneHeadStatusFromVisual({ tone: "waiting", pulse: true })).toBe("waiting")
    expect(paneHeadStatusFromVisual({ tone: "blueprint-waiting", pulse: true })).toBe("waiting")
  })

  test("waiting outranks busy status (attention demand wins)", () => {
    expect(paneHeadStatusFromVisual({ statusType: "busy", tone: "waiting", pulse: true })).toBe("waiting")
  })

  test("a paused blueprint audit reads completed when it has an unread result", () => {
    expect(paneHeadStatusFromVisual({ tone: "blueprint-audit", completionUnread: true })).toBe("completed")
  })

  test("idle tones with an unread completion notice read as completed", () => {
    expect(paneHeadStatusFromVisual({ tone: "default", completionUnread: true })).toBe("completed")
    expect(paneHeadStatusFromVisual({ tone: "muted", completionUnread: true })).toBe("completed")
    expect(paneHeadStatusFromVisual({ tone: "worktree", completionUnread: true })).toBe("completed")
  })

  test("plain idle tones without a completion notice stay neutral", () => {
    expect(paneHeadStatusFromVisual({ tone: "default" })).toBeUndefined()
    expect(paneHeadStatusFromVisual({ tone: "muted" })).toBeUndefined()
    expect(paneHeadStatusFromVisual({ tone: "blueprint" })).toBeUndefined()
    expect(paneHeadStatusFromVisual({})).toBeUndefined()
  })

  test("a session that is both busy and finished reads as working", () => {
    expect(paneHeadStatusFromVisual({ statusType: "busy", tone: "default", completionUnread: true })).toBe("working")
  })

  test("returns nothing for unavailable panes (no entry visual)", () => {
    expect(paneHeadStatusFromVisual({})).toBe<PaneHeadStatus>(undefined)
  })
})

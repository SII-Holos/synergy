import { describe, expect, mock, test } from "bun:test"
import type { PermissionRequest, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"

// The render-only Icon/Spinner components drag in lucide-solid, whose
// client-only `Dynamic` call crashes under bun:test. getActiveReason is a
// pure classification helper, so the two presentational imports are stubbed.
mock.module("@ericsanchezok/synergy-ui/icon", () => ({ Icon: () => null }))
mock.module("@ericsanchezok/synergy-ui/spinner", () => ({ Spinner: () => null }))
mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))

const { getActiveReason } = await import("../../../src/components/scopes/active-zone")

type ChildStore = Parameters<typeof getActiveReason>[1]

function session(id = "ses_1"): Session {
  return {
    id,
    scope: { id: "scope_1", type: "project", directory: "/repo" },
    title: "Session",
    version: "1.0.0",
    time: { created: 1, updated: 2 },
  }
}

function permission(sessionID: string): PermissionRequest {
  return { id: "per_1", sessionID, permission: "bash", patterns: ["ls"], metadata: {} }
}

function store(input: Partial<ChildStore> = {}): ChildStore {
  return {
    session_status: input.session_status ?? {},
    permission: input.permission ?? {},
    question: input.question ?? {},
  }
}

const notification = { session: { unseen: () => [] } }

describe("getActiveReason", () => {
  test("reports working for busy, retry, and recovering statuses", () => {
    const statuses: SessionStatus[] = [
      { type: "busy" },
      { type: "retry", attempt: 1, message: "rate limited", next: 100 },
      { type: "recovering" },
    ]
    for (const status of statuses) {
      expect(getActiveReason(session(), store({ session_status: { ses_1: status } }), notification)).toBe("working")
    }
  })

  test("reports nothing for idle and for a missing status", () => {
    expect(getActiveReason(session(), store({ session_status: { ses_1: { type: "idle" } } }), notification)).toBeNull()
    expect(getActiveReason(session(), store(), notification)).toBeNull()
  })

  test("reports a pending permission request", () => {
    const childStore = store({ permission: { ses_1: [permission("ses_1")] } })
    expect(getActiveReason(session(), childStore, notification)).toBe("permission")
  })

  test("reports working when a busy status and a pending permission coexist", () => {
    const childStore = store({
      session_status: { ses_1: { type: "busy" } },
      permission: { ses_1: [permission("ses_1")] },
    })
    expect(getActiveReason(session(), childStore, notification)).toBe("working")
  })

  test("reports an error notice before other unseen activity", () => {
    const withError = { session: { unseen: () => [{ type: "error" }, { type: "info" }] } }
    const withNotice = { session: { unseen: () => [{ type: "info" }] } }
    expect(getActiveReason(session(), store(), withError)).toBe("error")
    expect(getActiveReason(session(), store(), withNotice)).toBe("notification")
  })
})

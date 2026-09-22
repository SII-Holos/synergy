import { describe, expect, test } from "bun:test"
import type { I18n } from "@lingui/core"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import type { NavEntry } from "@/context/layout"
import { paneHeadStatusFromVisual } from "@/components/kanban/model/head-status"
import { resolveSessionVisualState } from "@/components/sidebar/session-visual-state"
import { resolveRuntimeIconState } from "@/components/status-bar/runtime"
import { classifySessionActivity, isWorkingStatus } from "@/utils/session-status"

// The three surfaces that render a single session's runtime state must agree.
// Classification is shared, so the only way they can disagree is if one of them
// stops reading the shared decision; this suite pins that they cannot.

function mockI18n(): I18n {
  return {
    _: (descriptor: { id: string; message: string; values?: Record<string, unknown> }) => {
      let message = descriptor.message
      if (descriptor.values) {
        for (const [key, value] of Object.entries(descriptor.values)) {
          message = message.replace(`{${key}}`, String(value))
        }
      }
      return message
    },
  } as unknown as I18n
}

function entry(): NavEntry {
  return {
    id: "ses_test",
    scopeID: "scp_project",
    scopeType: "project",
    title: "Test",
    category: "project",
    lastActivityAt: 1,
    pinned: 0,
    archived: false,
    completionNotice: { unread: false, unreadCount: 0 },
  }
}

const STATUSES: Array<{ label: string; status: SessionStatus | undefined }> = [
  { label: "idle", status: { type: "idle" } },
  { label: "busy", status: { type: "busy" } },
  { label: "retry", status: { type: "retry", attempt: 1, message: "rate limited", next: 1_000 } },
  { label: "paused", status: { type: "paused", reason: "interrupted", since: 1 } },
  { label: "missing", status: undefined },
]

const SIDEBAR_WORKING_TONES = new Set(["active", "retry"])

describe("cross-surface session state consistency", () => {
  for (const { label, status } of STATUSES) {
    for (const waiting of [false, true]) {
      const expected = classifySessionActivity({ status, waiting })

      test(`${label} + waiting=${waiting} classifies as ${expected} on every surface`, () => {
        const visual = resolveSessionVisualState({ entry: entry(), status, waiting })
        // Kanban receives the resolved tone plus the raw status it already holds.
        const head = paneHeadStatusFromVisual({
          statusType: status?.type,
          tone: visual.tone,
          pulse: visual.pulse,
        })
        const runtime = resolveRuntimeIconState(status, waiting, mockI18n())

        if (expected === "waiting") {
          expect(visual.tone).toBe("waiting")
          expect(head).toBe("waiting")
          expect(runtime.pulse).toBe(true)
          return
        }

        if (expected === "working") {
          // The sidebar carries work through a working tone (or the audit tone
          // for a pulsing audit), the board through "working", and the status
          // bar through a live pulse.
          expect(isWorkingStatus(status)).toBe(true)
          expect(SIDEBAR_WORKING_TONES.has(visual.tone) || visual.pulse === true).toBe(true)
          expect(head).toBe("working")
          expect(runtime.pulse).toBe(true)
          return
        }

        // Idle: no surface may report work, and a missing status must not be
        // mistaken for a running session.
        expect(isWorkingStatus(status)).toBe(false)
        expect(visual.pulse).toBeUndefined()
        expect(head).toBeUndefined()
        expect(runtime.pulse).toBe(false)
      })
    }
  }

  test("a missing status never reads as work on any surface", () => {
    const visual = resolveSessionVisualState({ entry: entry(), status: undefined })
    expect(visual.tone).toBe("default")
    expect(paneHeadStatusFromVisual({ statusType: undefined, tone: visual.tone })).toBeUndefined()
    expect(resolveRuntimeIconState(undefined, false, mockI18n()).pulse).toBe(false)
  })
})

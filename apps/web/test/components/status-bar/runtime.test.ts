import { describe, expect, test } from "bun:test"
import type { I18n } from "@lingui/core"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { resolveRuntimeIconState, runtimeLabel } from "../../../src/components/status-bar/runtime"

function mockI18n(): I18n {
  return {
    _: (descriptor: { id: string; message: string; values?: Record<string, unknown> }) => {
      let msg = descriptor.message
      if (descriptor.values) {
        for (const [key, value] of Object.entries(descriptor.values)) {
          msg = msg.replace(`{${key}}`, String(value))
        }
      }
      return msg
    },
  } as unknown as I18n
}

describe("status bar runtime state", () => {
  test("shows retry as a danger state with error tooltip and copy text", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "retry",
      attempt: 3,
      message: "Provider rate limit exceeded",
      next: Date.now() + 10_000,
    }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("retry 3")
    expect(state.icon).toBe(getSemanticIcon("session.retry"))
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
    expect(state.tooltip).toBe("Provider rate limit exceeded")
    expect(state.copyText).toBe("Provider rate limit exceeded")
  })

  test("keeps waiting priority above retry", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "retry",
      attempt: 1,
      message: "Provider unavailable",
      next: Date.now() + 10_000,
    }

    const state = resolveRuntimeIconState(status, true, i18n)

    expect(state.icon).toBe(getSemanticIcon("session.waiting"))
    expect(state.tone).toBe("danger")
    expect(state.tooltip).toBe("Runtime: waiting")
    expect(state.copyText).toBeUndefined()
  })

  test("keeps busy and idle runtime states unchanged", () => {
    const i18n = mockI18n()
    expect(resolveRuntimeIconState({ type: "busy", description: "running tool" }, false, i18n)).toMatchObject({
      icon: getSemanticIcon("session.running"),
      label: "running tool",
      tooltip: "Runtime: running tool",
      tone: "base",
      pulse: true,
    })

    expect(resolveRuntimeIconState({ type: "idle" }, false, i18n)).toMatchObject({
      icon: getSemanticIcon("session.idle"),
      label: "idle",
      tooltip: "Runtime: idle",
      tone: "base",
      pulse: false,
    })
  })

  test("shows a paused session as paused rather than working", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "paused",
      reason: "interrupted",
      description: "Stopped mid-work",
      since: 1,
    }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Stopped mid-work")
    expect(state.tone).toBe("paused")
    // A paused session is stopped: no pulse, because nothing will clear it.
    expect(state.pulse).toBe(false)
    expect(state.tooltip).toBe("Stopped mid-work")
    expect(state.copyText).toBe("Stopped mid-work")
  })

  test("reports the workflow cause when a workflow was driving the session", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "paused", reason: "workflow", since: 1 }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Stopped while a workflow was driving this session")
    expect(state.tooltip).toBe("Stopped while a workflow was driving this session")
    expect(state.copyText).toBe("Stopped while a workflow was driving this session")
    expect(state.tone).toBe("paused")
    expect(state.pulse).toBe(false)
  })

  test("reports the aborted cause when the user stopped the session", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "paused", reason: "aborted", since: 1 }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Stopped by you; continue to resume")
    expect(state.tooltip).toBe("Stopped by you; continue to resume")
  })

  test("reports the failed cause when the session stopped after a failure", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "paused", reason: "failed", since: 1 }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Stopped after a failure; continue to resume")
  })

  test("prefers the precise description over the localized cause", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "paused",
      reason: "workflow",
      description: "BlueprintLoop paused; resume to continue",
      since: 1,
    }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("BlueprintLoop paused; resume to continue")
    expect(state.tooltip).toBe("BlueprintLoop paused; resume to continue")
    expect(state.copyText).toBe("BlueprintLoop paused; resume to continue")
  })

  test("falls back to the cause copy when no description is present", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "paused", reason: "interrupted", since: 1 }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Stopped mid-work; continue to resume")
    expect(state.tooltip).toBe("Stopped mid-work; continue to resume")
    expect(state.tone).toBe("paused")
    expect(state.pulse).toBe(false)
  })

  test("renders a missing status as idle without a pulse", () => {
    const i18n = mockI18n()
    const state = resolveRuntimeIconState(undefined, false, i18n)

    expect(runtimeLabel(undefined, false, i18n)).toBe("idle")
    expect(state).toMatchObject({
      icon: getSemanticIcon("session.idle"),
      label: "idle",
      tooltip: "Runtime: idle",
      tone: "base",
      pulse: false,
    })
    expect(state.copyText).toBeUndefined()
  })

  test("keeps waiting above every runtime status", () => {
    const i18n = mockI18n()
    const statuses: Array<SessionStatus | undefined> = [
      undefined,
      { type: "idle" },
      { type: "busy", description: "running tool" },
      { type: "retry", attempt: 2, message: "Provider unavailable", next: 1_000 },
      { type: "paused", reason: "interrupted", description: "Stopped mid-work", since: 1 },
    ]

    for (const status of statuses) {
      const state = resolveRuntimeIconState(status, true, i18n)
      expect(state.icon).toBe(getSemanticIcon("session.waiting"))
      expect(state.tone).toBe("danger")
      expect(state.pulse).toBe(true)
      expect(state.tooltip).toBe("Runtime: waiting")
      expect(state.copyText).toBeUndefined()
    }
  })
})

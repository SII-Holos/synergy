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

  test("shows recovering as a danger state", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "recovering",
      description: "Recovering incomplete turn",
    }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Recovering incomplete turn")
    expect(state.icon).toBe(getSemanticIcon("session.retry"))
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
    expect(state.tooltip).toBe("Recovering incomplete turn")
    expect(state.copyText).toBe("Recovering incomplete turn")
  })

  test("reports the workflow cause when a BlueprintLoop holds the session", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "recovering", reason: "workflow" }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("A BlueprintLoop workflow is still holding this session")
    expect(state.tooltip).toBe("A BlueprintLoop workflow is still holding this session")
    expect(state.copyText).toBe("A BlueprintLoop workflow is still holding this session")
    expect(state.tooltip.toLowerCase()).not.toContain("incomplete turn")
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
  })

  test("reports the incomplete-turn cause when no workflow holds the session", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "recovering", reason: "incomplete-turn" }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Session is recovering from an incomplete turn")
    expect(state.tooltip).toBe("Session is recovering from an incomplete turn")
    expect(state.copyText).toBe("Session is recovering from an incomplete turn")
  })

  test("reports the pending-reply cause when a reply is unanswered", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "recovering", reason: "pending-reply" }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("Session is waiting for an unanswered reply")
    expect(state.tooltip).toBe("Session is waiting for an unanswered reply")
    expect(state.copyText).toBe("Session is waiting for an unanswered reply")
  })

  test("prefers the precise description over the localized cause", () => {
    const i18n = mockI18n()
    const status: SessionStatus = {
      type: "recovering",
      reason: "workflow",
      description: "BlueprintLoop paused; resume to continue",
    }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("BlueprintLoop paused; resume to continue")
    expect(state.tooltip).toBe("BlueprintLoop paused; resume to continue")
    expect(state.copyText).toBe("BlueprintLoop paused; resume to continue")
  })

  test("falls back without crashing when neither reason nor description is present", () => {
    const i18n = mockI18n()
    const status: SessionStatus = { type: "recovering" }

    const state = resolveRuntimeIconState(status, false, i18n)

    expect(runtimeLabel(status, false, i18n)).toBe("recovering")
    expect(state.tooltip).toBe("Session is recovering from an incomplete turn")
    expect(state.copyText).toBe("Session is recovering from an incomplete turn")
    expect(state.icon).toBe(getSemanticIcon("session.retry"))
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
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
      { type: "recovering", description: "Recovering incomplete turn" },
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

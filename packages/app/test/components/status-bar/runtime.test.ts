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
})

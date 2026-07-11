import { describe, expect, test } from "bun:test"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { resolveRuntimeIconState, runtimeLabel } from "./runtime"

describe("status bar runtime state", () => {
  test("shows retry as a danger state with error tooltip and copy text", () => {
    const status: SessionStatus = {
      type: "retry",
      attempt: 3,
      message: "Provider rate limit exceeded",
      next: Date.now() + 10_000,
    }

    const state = resolveRuntimeIconState(status, false)

    expect(runtimeLabel(status, false)).toBe("retry 3")
    expect(state.icon).toBe(getSemanticIcon("session.retry"))
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
    expect(state.tooltip).toBe("Provider rate limit exceeded")
    expect(state.copyText).toBe("Provider rate limit exceeded")
  })

  test("keeps waiting priority above retry", () => {
    const status: SessionStatus = {
      type: "retry",
      attempt: 1,
      message: "Provider unavailable",
      next: Date.now() + 10_000,
    }

    const state = resolveRuntimeIconState(status, true)

    expect(state.icon).toBe(getSemanticIcon("session.waiting"))
    expect(state.tone).toBe("danger")
    expect(state.tooltip).toBe("Runtime: waiting")
    expect(state.copyText).toBeUndefined()
  })

  test("keeps busy and idle runtime states unchanged", () => {
    expect(resolveRuntimeIconState({ type: "busy", description: "running tool" }, false)).toMatchObject({
      icon: getSemanticIcon("session.running"),
      label: "running tool",
      tooltip: "Runtime: running tool",
      tone: "base",
      pulse: true,
    })

    expect(resolveRuntimeIconState({ type: "idle" }, false)).toMatchObject({
      icon: getSemanticIcon("session.idle"),
      label: "idle",
      tooltip: "Runtime: idle",
      tone: "base",
      pulse: false,
    })
  })

  test("shows recovering as a danger state", () => {
    const status: SessionStatus = {
      type: "recovering",
      description: "Recovering incomplete turn",
    }

    const state = resolveRuntimeIconState(status, false)

    expect(runtimeLabel(status, false)).toBe("Recovering incomplete turn")
    expect(state.icon).toBe(getSemanticIcon("session.retry"))
    expect(state.tone).toBe("danger")
    expect(state.pulse).toBe(true)
    expect(state.tooltip).toBe("Recovering incomplete turn")
    expect(state.copyText).toBe("Recovering incomplete turn")
  })
})

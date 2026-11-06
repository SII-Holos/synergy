import { describe, expect, test } from "bun:test"
import { acquireNewSessionSubmitLock } from "../../../src/components/prompt-input/new-session-submit-lock"

function createPendingState(initial = false) {
  let pending = initial
  return {
    pending: () => pending,
    setPending: (value: boolean) => {
      pending = value
    },
  }
}

describe("new session submit lock", () => {
  test("blocks a second new-session submit until the first lease releases", () => {
    const state = createPendingState()

    const first = acquireNewSessionSubmitLock({
      ...state,
      isNewSession: true,
    })
    expect(first).toBeDefined()
    expect(state.pending()).toBe(true)

    const second = acquireNewSessionSubmitLock({
      ...state,
      isNewSession: true,
    })
    expect(second).toBeUndefined()

    first?.release()
    expect(state.pending()).toBe(false)

    const third = acquireNewSessionSubmitLock({
      ...state,
      isNewSession: true,
    })
    expect(third).toBeDefined()
  })

  test("does not touch pending state for existing-session submits", () => {
    const state = createPendingState()
    const lease = acquireNewSessionSubmitLock({
      ...state,
      isNewSession: false,
    })

    expect(lease).toBeDefined()
    expect(state.pending()).toBe(false)
    lease?.release()
    expect(state.pending()).toBe(false)
  })

  test("release is idempotent", () => {
    const state = createPendingState()
    const lease = acquireNewSessionSubmitLock({
      ...state,
      isNewSession: true,
    })

    expect(state.pending()).toBe(true)
    lease?.release()
    lease?.release()
    expect(state.pending()).toBe(false)
  })
})

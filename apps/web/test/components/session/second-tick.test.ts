import { describe, expect, test } from "bun:test"
import { createSecondTickSource } from "../../../src/components/session/second-tick"

function createHarness() {
  let hidden = false
  const visibilityListeners = new Set<() => void>()
  const state = {
    activeTimers: 0,
    fired: 0,
    /** Last scheduled callback, so tests can advance the fake clock. */
    fire: () => {},
  }
  const schedule = (fn: () => void) => {
    state.activeTimers++
    state.fire = fn
    return state.activeTimers
  }
  const cancel = () => {
    state.activeTimers--
  }
  const source = createSecondTickSource({
    schedule: (fn) => schedule(fn),
    cancel,
    isHidden: () => hidden,
    listenVisibility: (handler) => {
      visibilityListeners.add(handler)
      return () => visibilityListeners.delete(handler)
    },
  })
  return {
    source,
    state,
    setHidden(next: boolean) {
      hidden = next
      for (const handler of visibilityListeners) handler()
    },
  }
}

describe("second-tick shared source", () => {
  test("does not start a timer while nobody is subscribed", () => {
    const { state } = createHarness()
    expect(state.activeTimers).toBe(0)
  })

  test("starts the timer on first subscribe and increments the tick", () => {
    const { source, state } = createHarness()
    const unsubscribe = source.subscribe()
    expect(state.activeTimers).toBe(1)
    expect(source.read()).toBe(0)
    state.fire()
    expect(source.read()).toBe(1)
    unsubscribe()
    expect(state.activeTimers).toBe(0)
  })

  test("shares one timer across multiple subscribers", () => {
    const { source, state } = createHarness()
    const unsubA = source.subscribe()
    const unsubB = source.subscribe()
    expect(state.activeTimers).toBe(1)
    state.fire()
    expect(source.read()).toBe(1)
    unsubA()
    // Still one subscriber, timer keeps running.
    expect(state.activeTimers).toBe(1)
    unsubB()
    expect(state.activeTimers).toBe(0)
  })

  test("unsubscribe is idempotent", () => {
    const { source, state } = createHarness()
    const unsubscribe = source.subscribe()
    unsubscribe()
    unsubscribe()
    expect(state.activeTimers).toBe(0)
  })

  test("pauses the timer while hidden and resumes on visibility restore", () => {
    const { source, state, setHidden } = createHarness()
    const unsubscribe = source.subscribe()
    expect(state.activeTimers).toBe(1)

    setHidden(true)
    expect(state.activeTimers).toBe(0)

    setHidden(false)
    expect(state.activeTimers).toBe(1)
    state.fire()
    expect(source.read()).toBe(1)
    unsubscribe()
  })

  test("defers starting until visible when subscribed while hidden", () => {
    const { source, state, setHidden } = createHarness()
    setHidden(true)
    const unsubscribe = source.subscribe()
    expect(state.activeTimers).toBe(0)
    setHidden(false)
    expect(state.activeTimers).toBe(1)
    unsubscribe()
    expect(state.activeTimers).toBe(0)
  })
})

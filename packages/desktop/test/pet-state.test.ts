import { describe, expect, test } from "bun:test"
import { PetStateMachine, type PetBusEvent } from "../src/pet-state.js"

function machine(now: () => number, idleTimeoutMs = 5_000, transientMs = 4_000) {
  return new PetStateMachine({ idleTimeoutMs, transientMs, now })
}

function busySession(id: string): PetBusEvent {
  return {
    type: "session.updated",
    properties: { info: { id, working: { status: "busy" } } },
  }
}

function idleSession(id: string): PetBusEvent {
  return {
    type: "session.updated",
    properties: { info: { id, working: undefined, pendingReply: false } },
  }
}

function completed(id: string): PetBusEvent {
  return { type: "session.completion", properties: { sessionID: id, unreadCount: 1 } }
}

function sessionError(id: string): PetBusEvent {
  return { type: "session.error", properties: { sessionID: id } }
}

describe("pet state machine", () => {
  test("starts idle and stays idle without events", () => {
    const now = () => 0
    const state = machine(now)
    expect(state.snapshot().mood).toBe("idle")
    expect(state.tick(5_000)).toBe("idle")
  })

  test("switches to working while a session is busy and back to idle when it finishes", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    expect(state.handleEvent(busySession("s1"), 1_000)).toBe("working")
    expect(state.snapshot().activeSessions).toEqual(["s1"])
    expect(state.handleEvent(idleSession("s1"), 2_000)).toBe("idle")
    expect(state.snapshot().activeSessions).toEqual([])
  })

  test("tracks multiple active sessions and only idles when all finish", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    state.handleEvent(busySession("s1"), 1_000)
    state.handleEvent(busySession("s2"), 1_000)
    expect(state.snapshot().activeSessions.sort()).toEqual(["s1", "s2"])
    state.handleEvent(idleSession("s1"), 2_000)
    expect(state.snapshot().mood).toBe("working")
    state.handleEvent(idleSession("s2"), 3_000)
    expect(state.snapshot().mood).toBe("idle")
  })

  test("celebrates a completion when nothing else is active", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    state.handleEvent(busySession("s1"), 1_000)
    state.handleEvent(completed("s1"), 2_000)
    expect(state.snapshot().mood).toBe("celebrate")
    // Transient expires back to idle.
    expect(state.tick(2_000 + 4_000)).toBe("idle")
  })

  test("does not celebrate when another session is still active", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    state.handleEvent(busySession("s1"), 1_000)
    state.handleEvent(busySession("s2"), 1_000)
    state.handleEvent(completed("s1"), 2_000)
    expect(state.snapshot().mood).toBe("working")
  })

  test("shows angry on a session error when nothing else is active", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    state.handleEvent(busySession("s1"), 1_000)
    state.handleEvent(sessionError("s1"), 2_000)
    expect(state.snapshot().mood).toBe("angry")
    expect(state.tick(2_000 + 4_000)).toBe("idle")
  })

  test("degrades idle to sleepy after the idle timeout and wakes on activity", () => {
    let t = 0
    const now = () => t
    const state = machine(now, 5_000)
    state.handleEvent(busySession("s1"), 0)
    state.handleEvent(idleSession("s1"), 1_000)
    expect(state.tick(3_000)).toBe("idle")
    expect(state.tick(7_000)).toBe("sleepy")
    expect(state.handleEvent(busySession("s2"), 8_000)).toBe("working")
    expect(state.tick(9_000)).toBe("working")
  })

  test("poke triggers a short happy reaction", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    expect(state.poke(1_000)).toBe("happy")
    expect(state.tick(1_000 + 4_000)).toBe("idle")
  })

  test("dragging overrides the mood and release returns to the evaluated mood", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    state.handleEvent(busySession("s1"), 1_000)
    expect(state.setDragging(true, 2_000)).toBe("dragging")
    expect(state.setDragging(false, 3_000)).toBe("working")
  })

  test("handles malformed events without throwing", () => {
    let t = 0
    const now = () => t
    const state = machine(now)
    expect(state.handleEvent({}, 1_000)).toBe("idle")
    expect(state.handleEvent({ type: "unknown.type", properties: {} }, 2_000)).toBe("idle")
    expect(state.handleEvent({ type: "session.updated", properties: {} }, 3_000)).toBe("idle")
  })
})

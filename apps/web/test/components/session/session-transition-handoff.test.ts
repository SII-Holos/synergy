import { describe, expect, test } from "bun:test"
import {
  SESSION_TRANSITION_HANDOFF_TIMEOUT_MS,
  decideSessionTransitionHandoff,
  isSessionTransitionHandoffReady,
  recoverSessionTransitionHandoff,
  scheduleSessionTransitionHandoffDeadline,
} from "../../../src/components/session/session-transition-handoff"

const messageID = "msg_first"

describe("new session transition handoff", () => {
  test("waits for the expected visible canonical root message", () => {
    expect(isSessionTransitionHandoffReady(messageID, [])).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: false, visible: true }]),
    ).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: true, visible: false }]),
    ).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_other", role: "user", isRoot: true, visible: true }]),
    ).toBe(false)
    const optimisticMessage = {
      id: "msg_first",
      role: "user",
      isRoot: true,
      visible: true,
      metadata: { synergyClientOptimistic: { pending: true } },
    } as const
    expect(isSessionTransitionHandoffReady(messageID, [optimisticMessage])).toBe(false)
    expect(
      isSessionTransitionHandoffReady(messageID, [{ id: "msg_first", role: "user", isRoot: true, visible: true }]),
    ).toBe(true)
  })

  test("refreshes once when the inbox commits before the root is observed", () => {
    const input = {
      messageID,
      messages: [],
      inbox: [],
      elapsedMs: 1_000,
    }

    expect(decideSessionTransitionHandoff({ ...input, refreshAttempted: false })).toBe("refresh")
    expect(decideSessionTransitionHandoff({ ...input, refreshAttempted: true })).toBe("waiting")
  })

  test("stalls after the bounded handoff deadline but still prefers a canonical root", () => {
    const stalled = {
      messageID,
      messages: [],
      inbox: [{ messageID }],
      refreshAttempted: false,
      elapsedMs: SESSION_TRANSITION_HANDOFF_TIMEOUT_MS,
    }

    expect(decideSessionTransitionHandoff(stalled)).toBe("stalled")
    expect(
      decideSessionTransitionHandoff({
        ...stalled,
        messages: [{ id: messageID, role: "user", isRoot: true, visible: true }],
      }),
    ).toBe("ready")
  })

  test("recovers an accepted handoff from one durable first task", () => {
    const pending = {
      id: "inb_first",
      mode: "task",
      messageID,
      message: {
        role: "user",
        origin: { type: "user" },
        visible: true,
        metadata: { sessionTransition: { workspaceSelection: { mode: "create" as const } } },
      },
      source: { type: "user" },
      time: { created: 123 },
    }

    expect(recoverSessionTransitionHandoff({ messages: undefined, inbox: [pending] })).toBeUndefined()
    expect(recoverSessionTransitionHandoff({ messages: [], inbox: [pending] })).toEqual({
      itemID: "inb_first",
      messageID,
      acceptedAt: 123,
      workspaceSelection: { mode: "create" },
    })
    expect(recoverSessionTransitionHandoff({ messages: [{ id: "msg_existing" }], inbox: [pending] })).toBeUndefined()
    expect(
      recoverSessionTransitionHandoff({ messages: [], inbox: [pending, { ...pending, id: "inb_second" }] }),
    ).toBeUndefined()
  })
})

describe("session transition handoff deadline", () => {
  // Deadline window = acceptedAt + TIMEOUT; clock starts at 0 so the deadline
  // lands exactly at SESSION_TRANSITION_HANDOFF_TIMEOUT_MS.
  const attempt = { messageID: "msg_first", acceptedAt: 0 }

  function createClock() {
    let current = 0
    const timers = new Map<number, { fn: () => void; at: number }>()
    let nextHandle = 1
    return {
      now: () => current,
      advance(ms: number) {
        current += ms
        for (const [handle, timer] of [...timers]) {
          if (timer.at <= current) {
            timers.delete(handle)
            timer.fn()
          }
        }
      },
      schedule(fn: () => void, delay: number) {
        const handle = nextHandle++
        timers.set(handle, { fn, at: current + delay })
        return handle
      },
      cancel(handle: unknown) {
        timers.delete(handle as number)
      },
      pendingCount: () => timers.size,
    }
  }

  test("fires onDeadline once when the attempt is still current and the window elapses", () => {
    const clock = createClock()
    let fired = 0
    scheduleSessionTransitionHandoffDeadline(
      attempt,
      () => true,
      () => fired++,
      {
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
      },
    )
    clock.advance(SESSION_TRANSITION_HANDOFF_TIMEOUT_MS - 1)
    expect(fired).toBe(0)
    clock.advance(1)
    expect(fired).toBe(1)
    // The deadline is one-shot; nothing fires on a later tick.
    clock.advance(SESSION_TRANSITION_HANDOFF_TIMEOUT_MS)
    expect(fired).toBe(1)
  })

  test("skips the deadline when the attempt is no longer current", () => {
    const clock = createClock()
    let fired = 0
    scheduleSessionTransitionHandoffDeadline(
      attempt,
      () => false,
      () => fired++,
      {
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
      },
    )
    clock.advance(SESSION_TRANSITION_HANDOFF_TIMEOUT_MS)
    expect(fired).toBe(0)
  })

  test("cancel stops the pending deadline", () => {
    const clock = createClock()
    let fired = 0
    const cancel = scheduleSessionTransitionHandoffDeadline(
      attempt,
      () => true,
      () => fired++,
      {
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
      },
    )
    cancel()
    cancel()
    clock.advance(SESSION_TRANSITION_HANDOFF_TIMEOUT_MS)
    expect(fired).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })

  test("schedules with the remaining delay when acceptedAt is in the past", () => {
    const clock = createClock()
    let fired = 0
    // 10s of the 30s window have already elapsed; only 20s remain.
    clock.advance(10_000)
    scheduleSessionTransitionHandoffDeadline(
      attempt,
      () => true,
      () => fired++,
      {
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
      },
    )
    clock.advance(20_000 - 1)
    expect(fired).toBe(0)
    clock.advance(1)
    expect(fired).toBe(1)
  })
})

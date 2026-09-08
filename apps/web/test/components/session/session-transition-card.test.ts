import { describe, expect, test } from "bun:test"
import {
  createSessionTransitionLifecycle,
  SESSION_TRANSITION_EXIT_MS,
  SESSION_TRANSITION_SUCCESS_HOLD_MS,
  type SessionTransitionTimerDriver,
} from "../../../src/components/session/session-transition-card-lifecycle"

type TimerTask = {
  callback: () => void
  delay: number
  cancelled: boolean
}

function deterministicTimers() {
  const tasks: TimerTask[] = []
  const driver: SessionTransitionTimerDriver<TimerTask> = {
    setTimeout(callback, delay) {
      const task = { callback, delay, cancelled: false }
      tasks.push(task)
      return task
    },
    clearTimeout(task) {
      task.cancelled = true
    },
  }
  const run = (index: number) => {
    const task = tasks[index]
    if (!task || task.cancelled) return
    task.callback()
  }
  return { driver, tasks, run }
}

describe("session transition card lifecycle", () => {
  test("holds success for three seconds before fading and dismissing", () => {
    const timers = deterministicTimers()
    const events: string[] = []
    const lifecycle = createSessionTransitionLifecycle({
      phase: "success",
      onExit: () => events.push("exit"),
      onDismiss: () => events.push("dismiss"),
      timers: timers.driver,
    })

    expect(timers.tasks.map((task) => task.delay)).toEqual([SESSION_TRANSITION_SUCCESS_HOLD_MS])
    expect(SESSION_TRANSITION_SUCCESS_HOLD_MS).toBe(3_000)
    expect(events).toEqual([])

    timers.run(0)
    expect(events).toEqual(["exit"])
    expect(timers.tasks.map((task) => task.delay)).toEqual([
      SESSION_TRANSITION_SUCCESS_HOLD_MS,
      SESSION_TRANSITION_EXIT_MS,
    ])
    expect(SESSION_TRANSITION_EXIT_MS).toBe(180)

    timers.run(1)
    expect(events).toEqual(["exit", "dismiss"])
    lifecycle.beginExit()
    expect(events).toEqual(["exit", "dismiss"])
  })

  test("does not auto-dismiss loading or error transitions", () => {
    for (const phase of ["loading", "error"] as const) {
      const timers = deterministicTimers()
      const lifecycle = createSessionTransitionLifecycle({
        phase,
        onExit: () => undefined,
        onDismiss: () => undefined,
        timers: timers.driver,
      })

      expect(timers.tasks).toEqual([])
      lifecycle.cleanup()
    }
  })

  test("manual dismiss reuses the fade path and remains idempotent", () => {
    const timers = deterministicTimers()
    const events: string[] = []
    const lifecycle = createSessionTransitionLifecycle({
      phase: "success",
      onExit: () => events.push("exit"),
      onDismiss: () => events.push("dismiss"),
      timers: timers.driver,
    })

    lifecycle.beginExit()
    lifecycle.beginExit()
    expect(events).toEqual(["exit"])
    expect(timers.tasks[0]?.cancelled).toBe(true)
    expect(timers.tasks[1]?.delay).toBe(SESSION_TRANSITION_EXIT_MS)

    timers.run(1)
    lifecycle.beginExit()
    expect(events).toEqual(["exit", "dismiss"])
  })

  test("cleanup cancels timers and removes terminal success state once", () => {
    const holdTimers = deterministicTimers()
    const holdEvents: string[] = []
    const holding = createSessionTransitionLifecycle({
      phase: "success",
      onExit: () => holdEvents.push("exit"),
      onDismiss: () => holdEvents.push("dismiss"),
      timers: holdTimers.driver,
    })
    holding.cleanup()
    holdTimers.run(0)
    holding.cleanup()
    expect(holdEvents).toEqual(["dismiss"])

    const exitTimers = deterministicTimers()
    const exitEvents: string[] = []
    const exiting = createSessionTransitionLifecycle({
      phase: "loading",
      onExit: () => exitEvents.push("exit"),
      onDismiss: () => exitEvents.push("dismiss"),
      timers: exitTimers.driver,
    })
    exiting.beginExit()
    exiting.cleanup()
    exitTimers.run(0)
    expect(exitEvents).toEqual(["exit"])
  })
})

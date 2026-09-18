import { describe, expect, test } from "bun:test"
import { createPartRepairScheduler } from "../../src/context/part-repair-scheduler"

function manualClock() {
  let now = 0
  const tasks: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const task = { at: now + ms, fn, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
    advance: (ms: number) => {
      now += ms
      for (const task of tasks) {
        if (!task.cancelled && task.at <= now) {
          task.cancelled = true
          task.fn()
        }
      }
    },
  }
}

const key = (scopeKey: string, sessionID: string) => `${scopeKey}\n${sessionID}`

describe("createPartRepairScheduler", () => {
  test("debounces a burst of requests into one repair", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 2000, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope", "ses_a")
    scheduler.request("scope", "ses_a")
    scheduler.request("scope", "ses_a")
    expect(repairs).toEqual([])
    clock.advance(2100)
    expect(repairs).toEqual([key("scope", "ses_a")])
  })

  test("stops repairing once the attempt budget is exhausted within the window", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 1000, maxAttempts: 2, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    expect(repairs.length).toBe(2)
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    expect(repairs.length).toBe(2)
  })

  test("resets the budget after the attempt window passes", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 1000, windowMs: 5000, maxAttempts: 2, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    expect(repairs.length).toBe(2)
    clock.advance(5000)
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    expect(repairs.length).toBe(3)
  })

  test("clear cancels a pending repair and forgets the session budget", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 1000, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope", "ses_a")
    scheduler.clear("scope", "ses_a")
    clock.advance(1100)
    expect(repairs).toEqual([])
    scheduler.request("scope", "ses_a")
    clock.advance(1100)
    expect(repairs).toEqual([key("scope", "ses_a")])
  })

  test("clearScope cancels every pending repair for one scope only", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 1000, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope-a", "ses_a")
    scheduler.request("scope-b", "ses_b")
    scheduler.clearScope("scope-a")
    clock.advance(1100)
    expect(repairs).toEqual([key("scope-b", "ses_b")])
  })

  test("dispose cancels every pending repair", () => {
    const clock = manualClock()
    const repairs: string[] = []
    const scheduler = createPartRepairScheduler(
      { delayMs: 1000, now: clock.now, schedule: clock.schedule },
      (scopeKey, sessionID) => repairs.push(key(scopeKey, sessionID)),
    )
    scheduler.request("scope", "ses_a")
    scheduler.request("scope", "ses_b")
    scheduler.dispose()
    clock.advance(5000)
    expect(repairs).toEqual([])
  })
})

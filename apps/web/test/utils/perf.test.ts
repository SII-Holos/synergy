import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as metrics from "../../src/components/performance/browser-metrics"
import { navMark, navParams, navStart } from "../../src/utils/perf"

type Switch = { sessionID: string; reason: string; marks: Record<string, number> }

const recorded: Switch[] = []
const timers: Array<() => void> = []

// The navigation registry is module-level state shared across the file, so every
// test uses its own session id rather than resetting the module.
function reasons() {
  return recorded.map((value) => value.reason)
}

describe("session navigation completion", () => {
  let restore: Array<() => void> = []

  beforeEach(() => {
    recorded.length = 0
    timers.length = 0
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      timers.push(callback as () => void)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    const record = spyOn(metrics, "recordSessionSwitchTiming").mockImplementation(((input: Switch) => {
      recorded.push(input)
    }) as never)
    restore = [() => timer.mockRestore(), () => record.mockRestore()]
  })

  afterEach(() => {
    while (restore.length > 0) restore.pop()!()
  })

  test("resolves complete on session data readiness without any panel mark", () => {
    const to = "ses_ready"
    navStart({ to })
    navParams({ to })
    navMark({ to, name: "session:data-ready" })

    expect(reasons()).toEqual(["complete"])
    expect(recorded[0]!.sessionID).toBe(to)
    expect(recorded[0]!.marks["session:params"]).toBeDefined()
    expect(recorded[0]!.marks["session:data-ready"]).toBeDefined()
  })

  test("does not gate completion on panel-level marks", () => {
    const to = "ses_panel_only"
    navStart({ to })
    navParams({ to })
    for (const name of [
      "session:first-turn-mounted",
      "storage:prompt-ready",
      "storage:terminal-ready",
      "storage:file-view-ready",
    ]) {
      navMark({ to, name })
    }

    expect(reasons(), "panel marks must not complete a switch without data readiness").toEqual([])
  })

  test("resolves timeout when a required mark never arrives", () => {
    const to = "ses_pending"
    navStart({ to })
    navParams({ to })
    navMark({ to, name: "storage:prompt-ready" })

    expect(reasons()).toEqual([])
    expect(timers).toHaveLength(1)

    timers[0]!()

    expect(reasons()).toEqual(["timeout"])
    expect(recorded[0]!.sessionID).toBe(to)
    expect(recorded[0]!.marks["session:data-ready"]).toBeUndefined()
  })

  test("a navigation still records its actual completion after the slow deadline", () => {
    const to = "slow-navigation"
    navStart({ to })
    navParams({ to })
    timers[0]!()
    for (const name of [
      "session:data-ready",
      "session:first-turn-mounted",
      "storage:prompt-ready",
      "storage:terminal-ready",
      "storage:file-view-ready",
    ]) {
      navMark({ to, name })
    }

    expect(reasons()).toEqual(["timeout", "complete"])
  })

  test("emits once per completed switch and ignores later marks", () => {
    const to = "ses_once"
    navStart({ to })
    navParams({ to })
    navMark({ to, name: "session:data-ready" })
    navMark({ to, name: "storage:prompt-ready" })

    expect(reasons()).toEqual(["complete"])
  })
})

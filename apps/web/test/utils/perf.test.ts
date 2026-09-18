import { expect, spyOn, test } from "bun:test"
import * as metrics from "../../src/components/performance/browser-metrics"
import { navStart, navParams, navMark } from "../../src/utils/perf"

test("a navigation still records its actual completion after the slow deadline", () => {
  const timers: Array<() => void> = []
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler) => {
    timers.push(callback as () => void)
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout)
  const record = spyOn(metrics, "recordSessionSwitchTiming").mockImplementation(() => {})
  try {
    const to = "slow-navigation"
    navStart({ to })
    navParams({ to })
    timers[0]()
    for (const name of [
      "session:data-ready",
      "session:first-turn-mounted",
      "storage:prompt-ready",
      "storage:terminal-ready",
      "storage:file-view-ready",
    ])
      navMark({ to, name })
    expect(record.mock.calls.map(([value]) => value.reason)).toEqual(["timeout", "complete"])
  } finally {
    timer.mockRestore()
    record.mockRestore()
  }
})

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as browserMetrics from "@/components/performance/browser-metrics"

type Switch = { sessionID: string; reason: string; marks: Record<string, number> }

const recorded: Switch[] = []
const pendingTimeouts: Array<() => void> = []

// Bun's mock.module is process-global, so the factory must reproduce every real
// export. Spreading the statically imported module keeps sibling suites that
// import this module in the same process working, and only the recorder is
// replaced.
mock.module("@/components/performance/browser-metrics", () => ({
  ...browserMetrics,
  recordSessionSwitchTiming: (input: Switch) => {
    recorded.push({ sessionID: input.sessionID, reason: input.reason, marks: input.marks })
  },
}))

const realSetTimeout = globalThis.setTimeout

const perf = await import("../../src/utils/perf")

function nav(to: string, marks: string[]) {
  perf.navStart({ to })
  perf.navParams({ to })
  for (const name of marks) perf.navMark({ to, name })
}

describe("session navigation completion", () => {
  beforeEach(() => {
    recorded.length = 0
    pendingTimeouts.length = 0
    ;(globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      pendingTimeouts.push(fn)
      return pendingTimeouts.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown
  })

  afterEach(() => {
    ;(globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout
  })

  test("resolves complete on session data readiness without any panel mark", () => {
    nav("ses_ready", ["session:data-ready"])

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.reason).toBe("complete")
    expect(recorded[0]!.sessionID).toBe("ses_ready")
    expect(recorded[0]!.marks["session:params"]).toBeDefined()
    expect(recorded[0]!.marks["session:data-ready"]).toBeDefined()
  })

  test("does not gate completion on panel-level marks", () => {
    const to = "ses_panel_only"
    perf.navStart({ to })
    perf.navParams({ to })
    for (const name of [
      "session:first-turn-mounted",
      "storage:prompt-ready",
      "storage:terminal-ready",
      "storage:file-view-ready",
    ]) {
      perf.navMark({ to, name })
    }

    expect(recorded, "panel marks must not complete a switch without data readiness").toHaveLength(0)
  })

  test("resolves timeout when a required mark never arrives", () => {
    const to = "ses_pending"
    perf.navStart({ to })
    perf.navParams({ to })
    perf.navMark({ to, name: "storage:prompt-ready" })

    expect(recorded).toHaveLength(0)
    expect(pendingTimeouts).toHaveLength(1)

    pendingTimeouts[0]!()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.reason).toBe("timeout")
    expect(recorded[0]!.sessionID).toBe(to)
    expect(recorded[0]!.marks["session:data-ready"]).toBeUndefined()
  })

  test("resolves once per switch and ignores later marks", () => {
    nav("ses_once", ["session:data-ready"])
    perf.navMark({ to: "ses_once", name: "storage:prompt-ready" })

    expect(recorded).toHaveLength(1)
    expect(pendingTimeouts).toHaveLength(1)
  })
})

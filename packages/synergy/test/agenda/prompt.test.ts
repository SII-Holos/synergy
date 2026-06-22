import { describe, expect, test } from "bun:test"
import { AgendaPrompt } from "../../src/agenda/prompt"
import { AgendaTypes } from "../../src/agenda/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AgendaTypes.Item> & { id: string }): AgendaTypes.Item {
  const now = Date.now()
  return {
    status: "active",
    title: `Test item ${overrides.id}`,
    global: false,
    triggers: [],
    prompt: "你醒了。",
    wake: true,
    silent: false,
    autoDone: false,
    origin: {
      scope: {
        type: "project",
        id: "scope-1",
        directory: "/tmp",
        worktree: "/tmp",
        sandboxes: [],
        time: { created: now, updated: now },
      },
    },
    createdBy: "user",
    state: { consecutiveErrors: 0, runCount: 0 },
    time: { created: now, updated: now },
    ...overrides,
  }
}

function cronTrigger(expr: string, tz?: string): AgendaTypes.Trigger {
  return { type: "cron", expr, tz }
}

function makeSignal(overrides: Partial<AgendaTypes.FiredSignal> = {}): AgendaTypes.FiredSignal {
  return {
    type: "cron",
    source: "anima-daily",
    timestamp: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Signal mode — cron trigger
// ---------------------------------------------------------------------------

describe("AgendaPrompt.build in signal mode", () => {
  test("cron trigger includes type, timestamp, and run number", () => {
    const item = makeItem({
      id: "agd_signal_cron",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "你醒了。",
      state: { consecutiveErrors: 0, runCount: 5 },
    })
    const signal = makeSignal({
      type: "cron",
      source: "anima-daily",
      timestamp: Date.now(),
    })

    const result = AgendaPrompt.build(item, signal, "signal")

    // Must open with the signal context line
    expect(result).toContain("<agenda-signal ")
    expect(result).toContain('type="cron"')
    expect(result).toContain("fired=")
    expect(result).toContain('run="6"')
    // Prompt follows the signal line
    const lines = result.split("\n")
    expect(lines[lines.length - 1]).toBe("你醒了。")
  })

  test("signal context uses the trigger timezone for the fired timestamp format", () => {
    // Use a fixed timestamp to test deterministic formatting
    const fixedTs = new Date("2026-06-22T03:00:00+08:00").getTime()
    const item = makeItem({
      id: "agd_tz",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "你醒了。",
      state: { consecutiveErrors: 0, runCount: 41 },
    })
    const signal = makeSignal({ timestamp: fixedTs })

    const result = AgendaPrompt.build(item, signal, "signal")

    // The fired timestamp should include the timezone offset or abbreviation
    // and reflect local time 03:00 on 2026-06-22
    expect(result).toContain("03:00")
    expect(result).toContain("2026-06-22")
    expect(result).toContain('run="42"')
  })

  test("first run reports run=1 when runCount is 0", () => {
    const item = makeItem({
      id: "agd_first_run",
      triggers: [cronTrigger("0 9 * * *", "UTC")],
      prompt: "首次执行。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const signal = makeSignal()

    const result = AgendaPrompt.build(item, signal, "signal")

    expect(result).toContain('run="1"')
    expect(result).toContain("首次执行。")
  })

  test("missing tz in cron trigger still produces a valid signal context", () => {
    const item = makeItem({
      id: "agd_no_tz",
      triggers: [cronTrigger("0 3 * * *")], // no tz
      prompt: "你醒了。",
      state: { consecutiveErrors: 0, runCount: 3 },
    })
    const signal = makeSignal()

    const result = AgendaPrompt.build(item, signal, "signal")

    // Signal context must still be present with type and run
    expect(result).toContain("<agenda-signal ")
    expect(result).toContain('type="cron"')
    expect(result).toContain('run="4"')
    expect(result).toContain("fired=")
    // Prompt is present
    expect(result).toContain("你醒了。")
  })
})

// ---------------------------------------------------------------------------
// Signal mode — payload
// ---------------------------------------------------------------------------

describe("AgendaPrompt.build in signal mode with payload", () => {
  test("payload is included alongside signal context", () => {
    const item = makeItem({
      id: "agd_payload",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "处理文件变更。",
      state: { consecutiveErrors: 0, runCount: 2 },
    })
    const signal: AgendaTypes.FiredSignal = {
      type: "watch",
      source: "file-watcher",
      timestamp: Date.now(),
      payload: { file: "src/app.ts", event: "change" },
    }

    const result = AgendaPrompt.build(item, signal, "signal")

    // Signal context line comes first
    const lines = result.split("\n")
    expect(lines[0]).toContain("<agenda-signal ")
    // Payload is present (from formatSignalPayload)
    expect(result).toContain("src/app.ts")
    expect(result).toContain('event="change"')
    // Prompt is the last line
    expect(lines[lines.length - 1]).toBe("处理文件变更。")
  })

  test("signal context still appears when payload is absent", () => {
    const item = makeItem({
      id: "agd_no_payload",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "安静执行。",
      state: { consecutiveErrors: 0, runCount: 1 },
    })
    const signal = makeSignal({ type: "cron", source: "scheduler" })
    // No payload field
    delete (signal as Record<string, unknown>).payload

    const result = AgendaPrompt.build(item, signal, "signal")

    // Signal context line present
    expect(result).toContain("<agenda-signal ")
    expect(result).toContain('type="cron"')
    // No payload, so the result is signal line + prompt
    const lines = result.split("\n")
    expect(lines.length).toBe(2) // signal context + prompt
    expect(lines[1]).toBe("安静执行。")
  })
})

// ---------------------------------------------------------------------------
// Full mode — unchanged behavior
// ---------------------------------------------------------------------------

describe("AgendaPrompt.build in full mode", () => {
  test("full mode wraps prompt in agenda-context tags and does NOT include signal context", () => {
    const item = makeItem({
      id: "agd_full",
      title: "晨间问候",
      triggers: [cronTrigger("0 9 * * *", "Asia/Shanghai")],
      prompt: "早上好。",
      state: { consecutiveErrors: 0, runCount: 3 },
    })
    const signal = makeSignal()

    const result = AgendaPrompt.build(item, signal, "full")

    // Full mode uses the existing <agenda-context> wrapper
    expect(result).toContain("<agenda-context>")
    expect(result).toContain("</agenda-context>")
    expect(result).toContain("<title>晨间问候</title>")
    expect(result).toContain("<task>")
    expect(result).toContain("早上好。")
    expect(result).toContain("</task>")
    // Full mode must NOT include the new signal context line
    expect(result).not.toContain("<agenda-signal")
    // Full mode keeps its own run number
    expect(result).toContain('run number="4"')
  })

  test("full mode with payload still works as before", () => {
    const item = makeItem({
      id: "agd_full_payload",
      title: "文件监控",
      triggers: [cronTrigger("0 * * * *")],
      prompt: "检查变更。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const signal: AgendaTypes.FiredSignal = {
      type: "watch",
      source: "watcher",
      timestamp: Date.now(),
      payload: { file: "test.ts", event: "change" },
    }

    const result = AgendaPrompt.build(item, signal, "full")

    expect(result).toContain("<agenda-context>")
    expect(result).toContain("<watch-event ")
    expect(result).toContain('file="test.ts"')
    expect(result).toContain("检查变更。")
  })
})

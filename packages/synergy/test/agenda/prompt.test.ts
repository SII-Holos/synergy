import { describe, expect, test } from "bun:test"
import { AgendaPrompt } from "../../src/agenda/prompt"
import { AgendaTypes } from "../../src/agenda/types"

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
  return { type: "cron", source: "anima-daily", timestamp: Date.now(), ...overrides }
}

describe("AgendaPrompt.build", () => {
  test("produces <agenda-context> wrapper with title, trigger, run, and task", () => {
    const item = makeItem({
      id: "agd_test",
      title: "晨间问候",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "你醒了。",
      state: { consecutiveErrors: 0, runCount: 5 },
    })
    const signal = makeSignal()
    const result = AgendaPrompt.build(item, signal)
    expect(result).toContain("<agenda-context>")
    expect(result).toContain("<title>晨间问候</title>")
    expect(result).toContain("cron")
    expect(result).toContain('run number="6"')
    expect(result).toContain("<task>")
    expect(result).toContain("你醒了。")
  })

  test("trigger fired timestamp is in ISO UTC format", () => {
    const fixedTs = new Date("2026-06-22T03:00:00+08:00").getTime()
    const item = makeItem({
      id: "agd_ts",
      triggers: [cronTrigger("0 3 * * *", "Asia/Shanghai")],
      prompt: "早。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const signal = makeSignal({ timestamp: fixedTs })
    const result = AgendaPrompt.build(item, signal)
    expect(result).toContain("2026-06-21T19:00:00.000Z")
    expect(result).toContain('run number="1"')
  })

  test("first run reports run number 1 when runCount is 0", () => {
    const item = makeItem({
      id: "agd_first",
      triggers: [cronTrigger("0 9 * * *")],
      prompt: "首次执行。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).toContain('run number="1"')
    expect(result).toContain("首次执行。")
  })

  test("always includes session refs when present", () => {
    const item = makeItem({
      id: "agd_refs",
      triggers: [cronTrigger("0 3 * * *")],
      prompt: "检查会话。",
      state: { consecutiveErrors: 0, runCount: 2 },
      sessionRefs: [
        { sessionID: "ses_abc", hint: "上周日记" },
        { sessionID: "ses_def", hint: "Agora 讨论" },
      ],
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).toContain("<context-sessions>")
    expect(result).toContain('id="ses_abc"')
    expect(result).toContain('hint="上周日记"')
    expect(result).toContain('hint="Agora 讨论"')
    expect(result).toContain("You can read the above sessions using tools")
  })

  test("omits session refs section when empty", () => {
    const item = makeItem({
      id: "agd_no_refs",
      triggers: [cronTrigger("0 3 * * *")],
      prompt: "无引用。",
      state: { consecutiveErrors: 0, runCount: 1 },
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).not.toContain("<context-sessions>")
  })

  test("includes watch payload when present", () => {
    const item = makeItem({
      id: "agd_watch",
      triggers: [cronTrigger("0 * * * *")],
      prompt: "检查变更。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const signal: AgendaTypes.FiredSignal = {
      type: "watch",
      source: "watcher",
      timestamp: Date.now(),
      payload: { file: "src/app.ts", event: "change" },
    }
    const result = AgendaPrompt.build(item, signal)
    expect(result).toContain("<watch-event ")
    expect(result).toContain('file="src/app.ts"')
    expect(result).toContain("检查变更。")
  })

  test("omits description and last-run when absent", () => {
    const item = makeItem({
      id: "agd_minimal",
      triggers: [cronTrigger("0 3 * * *")],
      prompt: "最小提示。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).not.toContain("<description>")
    expect(result).not.toContain("<last-run")
  })

  test("includes description when set", () => {
    const item = makeItem({
      id: "agd_desc",
      description: "每日触发任务",
      triggers: [cronTrigger("0 3 * * *")],
      prompt: "任务内容。",
      state: { consecutiveErrors: 0, runCount: 0 },
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).toContain("<description>每日触发任务</description>")
  })

  test("includes last-run error details", () => {
    const item = makeItem({
      id: "agd_error",
      triggers: [cronTrigger("0 3 * * *")],
      prompt: "重试。",
      state: {
        consecutiveErrors: 3,
        runCount: 5,
        lastRunAt: Date.now() - 3600000,
        lastRunStatus: "error",
        lastRunError: "timeout",
        lastRunDuration: 30000,
      },
    })
    const result = AgendaPrompt.build(item, makeSignal())
    expect(result).toContain('status="error"')
    expect(result).toContain("<last-run-error>timeout</last-run-error>")
    expect(result).toContain("<consecutive-errors>3</consecutive-errors>")
  })
})

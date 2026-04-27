import { describe, expect, test } from "bun:test"
import { AgendaDedup } from "../../src/agenda/dedup"
import { AgendaTypes } from "../../src/agenda/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function watchPoll(command: string): AgendaTypes.Trigger {
  return {
    type: "watch",
    watch: { kind: "poll", command, interval: "5m", trigger: "change" },
  }
}

function watchTool(tool: string, args?: Record<string, unknown>): AgendaTypes.Trigger {
  return {
    type: "watch",
    watch: { kind: "tool", tool, args, interval: "5m", trigger: "change" },
  }
}

function watchFile(glob: string, event?: "add" | "change" | "unlink"): AgendaTypes.Trigger {
  return {
    type: "watch",
    watch: { kind: "file", glob, event, debounce: "500ms" },
  }
}

function cronTrigger(expr: string, tz?: string): AgendaTypes.Trigger {
  return { type: "cron", expr, tz }
}

function everyTrigger(interval: string): AgendaTypes.Trigger {
  return { type: "every", interval }
}

// ---------------------------------------------------------------------------
// Title similarity (Token Jaccard)
//
// The question: "When should two titles be considered similar enough to warn?"
// Answer: When they share a majority of tokens — not just one word overlap.
// ---------------------------------------------------------------------------

describe("title similarity", () => {
  test("identical titles → 1.0", () => {
    expect(AgendaDedup.titleSimilarity("Monitor experiment", "Monitor experiment")).toBe(1)
  })

  test("completely different titles → 0", () => {
    expect(AgendaDedup.titleSimilarity("Monitor experiment", "Daily standup")).toBe(0)
  })

  test("partial overlap crosses threshold", () => {
    // "Monitor exp_007" vs "Monitor exp_007 results" — 2/3 overlap = 0.67
    const sim = AgendaDedup.titleSimilarity("Monitor exp_007", "Monitor exp_007 results")
    expect(sim).toBeGreaterThanOrEqual(0.5)
  })

  test("single shared word with very different titles → low", () => {
    // "Monitor experiment" vs "System monitor" — 1/3 overlap = 0.33
    const sim = AgendaDedup.titleSimilarity("Monitor experiment", "System monitor")
    expect(sim).toBeLessThan(0.5)
  })

  test("word order does not matter", () => {
    expect(AgendaDedup.titleSimilarity("Watch training", "training Watch")).toBe(1)
  })

  test("case insensitive", () => {
    expect(AgendaDedup.titleSimilarity("Monitor Experiment", "monitor experiment")).toBe(1)
  })

  test("empty vs empty → 1 (both vacuum, vacuously same)", () => {
    expect(AgendaDedup.titleSimilarity("", "")).toBe(1)
  })

  test("empty vs non-empty → 0", () => {
    expect(AgendaDedup.titleSimilarity("", "Something")).toBe(0)
  })

  test("extra words dilute similarity", () => {
    const short = "Check health"
    const long = "Check health endpoint every 5 minutes and alert on failure"
    const sim = AgendaDedup.titleSimilarity(short, long)
    // 2 tokens overlap out of ~10 total → well below threshold
    expect(sim).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Trigger structural matching
//
// The question: "When are two triggers doing the same work?"
// Answer: When they would produce identical side effects if both active.
// ---------------------------------------------------------------------------

describe("trigger conflict: watch(poll)", () => {
  test("same command → conflict", () => {
    expect(AgendaDedup.triggersConflict(watchPoll("ps aux | grep train"), watchPoll("ps aux | grep train"))).toBe(true)
  })

  test("different command → no conflict", () => {
    expect(AgendaDedup.triggersConflict(watchPoll("ps aux | grep train"), watchPoll("ps aux | grep web"))).toBe(false)
  })
})

describe("trigger conflict: watch(tool)", () => {
  test("same tool + same args → conflict", () => {
    expect(
      AgendaDedup.triggersConflict(
        watchTool("inspire_jobs", { status: "running" }),
        watchTool("inspire_jobs", { status: "running" }),
      ),
    ).toBe(true)
  })

  test("same tool + different args → no conflict (different job)", () => {
    expect(
      AgendaDedup.triggersConflict(
        watchTool("inspire_jobs", { job_id: "job-111" }),
        watchTool("inspire_jobs", { job_id: "job-222" }),
      ),
    ).toBe(false)
  })

  test("different tool → no conflict", () => {
    expect(
      AgendaDedup.triggersConflict(
        watchTool("inspire_jobs", { status: "running" }),
        watchTool("inspire_metrics", { job_id: "job-111" }),
      ),
    ).toBe(false)
  })

  test("same tool + no args on both → conflict", () => {
    expect(AgendaDedup.triggersConflict(watchTool("agenda_list"), watchTool("agenda_list"))).toBe(true)
  })
})

describe("trigger conflict: watch(file)", () => {
  test("same glob + same event → conflict", () => {
    expect(AgendaDedup.triggersConflict(watchFile("src/**/*.ts", "change"), watchFile("src/**/*.ts", "change"))).toBe(
      true,
    )
  })

  test("same glob + different event → no conflict", () => {
    expect(AgendaDedup.triggersConflict(watchFile("src/**/*.ts", "change"), watchFile("src/**/*.ts", "add"))).toBe(
      false,
    )
  })

  test("different glob → no conflict", () => {
    expect(AgendaDedup.triggersConflict(watchFile("src/**/*.ts"), watchFile("test/**/*.ts"))).toBe(false)
  })
})

describe("trigger conflict: across watch kinds", () => {
  test("poll vs tool → no conflict (different mechanisms)", () => {
    expect(AgendaDedup.triggersConflict(watchPoll("ps aux"), watchTool("bash", { command: "ps aux" }))).toBe(false)
  })

  test("poll vs file → no conflict", () => {
    expect(AgendaDedup.triggersConflict(watchPoll("ls"), watchFile("*.ts"))).toBe(false)
  })
})

describe("trigger conflict: cron", () => {
  test("same expr + same tz → conflict", () => {
    expect(
      AgendaDedup.triggersConflict(
        cronTrigger("0 9 * * *", "Asia/Shanghai"),
        cronTrigger("0 9 * * *", "Asia/Shanghai"),
      ),
    ).toBe(true)
  })

  test("same expr + different tz → no conflict (different wall time)", () => {
    expect(
      AgendaDedup.triggersConflict(cronTrigger("0 9 * * *", "Asia/Shanghai"), cronTrigger("0 9 * * *", "UTC")),
    ).toBe(false)
  })

  test("different expr → no conflict", () => {
    expect(AgendaDedup.triggersConflict(cronTrigger("0 9 * * *"), cronTrigger("0 18 * * *"))).toBe(false)
  })
})

describe("trigger conflict: every", () => {
  test("same interval → conflict", () => {
    expect(AgendaDedup.triggersConflict(everyTrigger("30m"), everyTrigger("30m"))).toBe(true)
  })

  test("different interval → no conflict", () => {
    expect(AgendaDedup.triggersConflict(everyTrigger("30m"), everyTrigger("1h"))).toBe(false)
  })
})

describe("trigger conflict: across types", () => {
  test("watch vs cron → no conflict", () => {
    expect(AgendaDedup.triggersConflict(watchPoll("echo"), cronTrigger("0 9 * * *"))).toBe(false)
  })

  test("cron vs every → no conflict", () => {
    expect(AgendaDedup.triggersConflict(cronTrigger("0 * * * *"), everyTrigger("1h"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Conflict message formatting
//
// The question: "Does the message give the agent enough info to decide?"
// ---------------------------------------------------------------------------

describe("conflict message", () => {
  function makeItem(overrides: Partial<AgendaTypes.Item> & { id: string }): AgendaTypes.Item {
    const now = Date.now()
    return {
      status: "active",
      title: `Item ${overrides.id}`,
      global: false,
      triggers: [],
      prompt: "test",
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
      createdBy: "agent",
      state: { consecutiveErrors: 0, runCount: 0 },
      time: { created: now, updated: now },
      ...overrides,
    }
  }

  test("includes item ID so agent can reference it in agenda_update", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [{ item: makeItem({ id: "agd_999", title: "X" }), reason: "trigger" }],
      "agenda_create",
    )
    expect(msg).toContain("agd_999")
    expect(msg).toContain("agenda_update")
  })

  test("suggests calling the same tool again with adjusted params", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [{ item: makeItem({ id: "agd_1", title: "X" }), reason: "title" }],
      "agenda_watch",
    )
    expect(msg).toContain("agenda_watch")
  })

  test("trigger conflict shows the watch target", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [
        {
          item: makeItem({
            id: "agd_1",
            title: "X",
            triggers: [watchTool("bash", { command: "curl -s http://example.com" })],
          }),
          reason: "trigger",
        },
      ],
      "agenda_watch",
    )
    expect(msg).toContain("bash")
  })

  test("cron conflict shows the expression", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [
        {
          item: makeItem({ id: "agd_1", title: "X", triggers: [cronTrigger("0 9 * * *", "Asia/Shanghai")] }),
          reason: "trigger",
        },
      ],
      "agenda_create",
    )
    expect(msg).toContain("cron: 0 9 * * *")
  })

  test("recent item shows 'just now'", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [{ item: makeItem({ id: "agd_1", title: "X" }), reason: "trigger" }],
      "agenda_create",
    )
    expect(msg).toContain("just now")
  })
})

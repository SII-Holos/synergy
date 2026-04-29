import { describe, expect, test } from "bun:test"
import { AgendaDedup } from "../../src/agenda/dedup"
import { AgendaTypes } from "../../src/agenda/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

describe("title similarity", () => {
  test("identical titles → 1.0", () => {
    expect(AgendaDedup.titleSimilarity("Monitor experiment", "Monitor experiment")).toBe(1)
  })

  test("completely different titles → 0", () => {
    expect(AgendaDedup.titleSimilarity("Monitor experiment", "Daily standup")).toBe(0)
  })

  test("partial overlap crosses threshold", () => {
    const sim = AgendaDedup.titleSimilarity("Monitor exp_007", "Monitor exp_007 results")
    expect(sim).toBeGreaterThanOrEqual(0.5)
  })

  test("single shared word with very different titles → low", () => {
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
    expect(sim).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Trigger structural matching
// ---------------------------------------------------------------------------

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
    expect(AgendaDedup.triggersConflict(watchFile("*.ts"), cronTrigger("0 9 * * *"))).toBe(false)
  })

  test("cron vs every → no conflict", () => {
    expect(AgendaDedup.triggersConflict(cronTrigger("0 * * * *"), everyTrigger("1h"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Conflict message formatting
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
      "agenda_schedule",
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

  test("cron conflict shows the expression", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [
        {
          item: makeItem({ id: "agd_1", title: "X", triggers: [cronTrigger("0 9 * * *", "Asia/Shanghai")] }),
          reason: "trigger",
        },
      ],
      "agenda_schedule",
    )
    expect(msg).toContain("cron: 0 9 * * *")
  })

  test("recent item shows 'just now'", () => {
    const msg = AgendaDedup.formatConflictMessage(
      [{ item: makeItem({ id: "agd_1", title: "X" }), reason: "trigger" }],
      "agenda_schedule",
    )
    expect(msg).toContain("just now")
  })
})

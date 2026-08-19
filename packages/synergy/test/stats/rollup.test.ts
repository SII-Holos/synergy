import { describe, expect, test } from "bun:test"
import { Rollup } from "../../src/stats/rollup"
import type { SessionDigest } from "../../src/stats/types"

function digest(overrides: Partial<SessionDigest> = {}): SessionDigest {
  return {
    sessionID: "ses-1",
    scopeID: "scope-1",
    created: new Date(2026, 0, 5, 10, 30).getTime(),
    updated: new Date(2026, 0, 5, 10, 35).getTime(),
    pinned: false,
    turns: 4,
    messages: 6,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
    cost: 0.25,
    modelUsage: {
      "provider-a/model-x": {
        messages: 3,
        tokens: { input: 60, output: 30, reasoning: 6, cache: { read: 12, write: 3 } },
        cost: 0.15,
        totalResponseMs: 900,
      },
    },
    agentUsage: {
      synergy: {
        messages: 6,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
        cost: 0.25,
      },
    },
    toolUsage: {
      bash: { calls: 5, successes: 4, errors: 1, totalDurationMs: 500 },
      read: { calls: 2, successes: 2, errors: 0, totalDurationMs: 100 },
    },
    hourlyTurns: { "2026-01-05T10": 4 },
    additions: 30,
    deletions: 10,
    files: 3,
    compactionCount: 1,
    retryCount: 2,
    errorCount: 1,
    durationMs: 5 * 60_000,
    ...overrides,
  }
}

describe("stats rollup", () => {
  test("computes an empty snapshot with zeroed dimensions", () => {
    const snapshot = Rollup.snapshot([], 0)
    expect(snapshot.overview.totalSessions).toBe(0)
    expect(snapshot.overview.projectCount).toBe(0)
    expect(snapshot.overview.totalDays).toBe(0)
    expect(snapshot.tokenCost.cost).toBe(0)
    expect(snapshot.models.models).toEqual([])
    expect(snapshot.agents.agents).toEqual([])
    expect(snapshot.tools.tools).toEqual([])
    expect(snapshot.codeChanges.totalAdditions).toBe(0)
    expect(snapshot.lifecycle.avgTurnsPerSession).toBe(0)
    expect(snapshot.channels.channels).toEqual([])
    expect(snapshot.timeSeries.days).toEqual([])
    expect(snapshot.watermark).toBe(0)
  })

  test("computes overview totals, streaks, and project count", () => {
    const snapshot = Rollup.snapshot(
      [digest(), digest({ sessionID: "ses-2", created: new Date(2026, 0, 6).getTime(), archived: 1 })],
      42,
    )
    expect(snapshot.overview.totalSessions).toBe(2)
    expect(snapshot.overview.activeSessions).toBe(1)
    expect(snapshot.overview.archivedSessions).toBe(1)
    expect(snapshot.overview.totalMessages).toBe(12)
    expect(snapshot.overview.totalTurns).toBe(8)
    expect(snapshot.overview.totalDays).toBe(2)
    expect(snapshot.overview.projectCount).toBe(1)
    expect(snapshot.watermark).toBe(42)
  })

  test("computes token cost dimensions including cache hit rate", () => {
    const snapshot = Rollup.snapshot([digest()], 0)
    expect(snapshot.tokenCost.tokens.input).toBe(100)
    expect(snapshot.tokenCost.tokens.output).toBe(50)
    expect(snapshot.tokenCost.tokens.reasoning).toBe(10)
    expect(snapshot.tokenCost.tokens.cache.read).toBe(20)
    expect(snapshot.tokenCost.cost).toBe(0.25)
    expect(snapshot.tokenCost.avgCostPerTurn).toBeCloseTo(0.0625)
    expect(snapshot.tokenCost.cacheHitRate).toBeCloseTo(20 / 120)
  })

  test("aggregates model usage and computes average response time", () => {
    const snapshot = Rollup.snapshot([digest()], 0)
    expect(snapshot.models.models).toHaveLength(1)
    const model = snapshot.models.models[0]!
    expect(model).toMatchObject({ providerID: "provider-a", modelID: "model-x", messages: 3, turns: 3 })
    expect(model.avgResponseMs).toBeCloseTo(300)
    expect(model.tokens.input).toBe(60)
  })

  test("aggregates agent usage and counts subagent invocations", () => {
    const parent = digest()
    const child = digest({ sessionID: "ses-child", parentID: "ses-1" })
    const snapshot = Rollup.snapshot([parent, child], 0)
    expect(snapshot.agents.totalSubagentCalls).toBe(1)
    const agent = snapshot.agents.agents.find((a) => a.agent === "synergy")!
    expect(agent.messages).toBe(12)
    expect(agent.sessions).toBe(2)
    expect(agent.subagentInvocations).toBe(1)
  })

  test("aggregates tool usage with weighted average durations", () => {
    const snapshot = Rollup.snapshot([digest()], 0)
    const tools = snapshot.tools.tools
    expect(tools).toHaveLength(2)
    const bash = tools.find((t) => t.tool === "bash")!
    expect(bash).toMatchObject({ calls: 5, successes: 4, errors: 1 })
    expect(bash.avgDurationMs).toBeCloseTo(100)
    const read = tools.find((t) => t.tool === "read")!
    expect(read.avgDurationMs).toBeCloseTo(50)
  })

  test("computes code change totals and daily averages", () => {
    const snapshot = Rollup.snapshot(
      [digest(), digest({ sessionID: "ses-2", created: new Date(2026, 0, 6).getTime() })],
      0,
    )
    expect(snapshot.codeChanges.totalAdditions).toBe(60)
    expect(snapshot.codeChanges.totalDeletions).toBe(20)
    expect(snapshot.codeChanges.totalFiles).toBe(6)
    expect(snapshot.codeChanges.netLines).toBe(40)
    expect(snapshot.codeChanges.dailyAdditions).toBeCloseTo(30)
  })

  test("computes lifecycle metrics with median and duration buckets", () => {
    const short = digest({ turns: 2, durationMs: 60_000, pinned: true })
    const medium = digest({ sessionID: "ses-2", turns: 6, durationMs: 10 * 60_000 })
    const long = digest({ sessionID: "ses-3", turns: 10, durationMs: 60 * 60_000 })
    const snapshot = Rollup.snapshot([short, medium, long], 0)
    expect(snapshot.lifecycle.pinnedCount).toBe(1)
    expect(snapshot.lifecycle.avgTurnsPerSession).toBeCloseTo(6)
    expect(snapshot.lifecycle.medianTurnsPerSession).toBe(6)
    expect(snapshot.lifecycle.compactionCount).toBe(3)
    expect(snapshot.lifecycle.retryCount).toBe(6)
    expect(snapshot.lifecycle.errorRate).toBeCloseTo(3 / 18)
    expect(snapshot.lifecycle.durationBuckets).toEqual({ short: 1, medium: 1, long: 1 })
  })

  test("computes channel stats from endpoints and interaction modes", () => {
    const web = digest()
    const feishu = digest({
      sessionID: "ses-2",
      endpoint: { kind: "feishu", type: "channel" },
      interaction: { mode: "unattended", source: "webhook" },
    })
    const snapshot = Rollup.snapshot([web, feishu], 0)
    expect(snapshot.channels.interactiveSessions).toBe(1)
    expect(snapshot.channels.unattendedSessions).toBe(1)
    expect(snapshot.channels.channels).toHaveLength(2)
    expect(snapshot.channels.channels.find((c) => c.channel === "channel")!.messages).toBe(6)
  })

  test("computes time series buckets and hourly activity", () => {
    const morning = digest({ created: new Date(2026, 0, 5, 9, 0).getTime(), hourlyTurns: { "2026-01-05T09": 3 } })
    const evening = digest({
      sessionID: "ses-2",
      created: new Date(2026, 0, 5, 21, 0).getTime(),
      hourlyTurns: { "2026-01-05T21": 2 },
    })
    const snapshot = Rollup.snapshot([morning, evening], 0)
    expect(snapshot.timeSeries.days).toHaveLength(1)
    expect(snapshot.timeSeries.days[0]!.turns).toBe(8)
    expect(snapshot.timeSeries.days[0]!.toolCalls).toBe(14)
    expect(snapshot.timeSeries.hours).toHaveLength(2)
    expect(snapshot.timeSeries.hours[0]!.turns).toBe(3)
    expect(snapshot.timeSeries.hourlyActivity[9]).toBe(3)
    expect(snapshot.timeSeries.hourlyActivity[21]).toBe(2)
  })

  test("mergeDailyBucket sums two buckets and passes through a missing existing bucket", () => {
    const first = Rollup.sessionToDailyBucket(digest())
    const second = Rollup.sessionToDailyBucket(digest({ sessionID: "ses-2" }))
    const merged = Rollup.mergeDailyBucket(first, second)
    expect(merged.sessions).toBe(2)
    expect(merged.turns).toBe(8)
    expect(merged.tokens.input).toBe(200)
    expect(merged.cost).toBe(0.5)
    expect(merged.toolCalls).toBe(14)
    expect(Rollup.mergeDailyBucket(undefined, second)).toEqual(second)
  })

  test("sessionToDailyBucket projects a digest into a daily bucket", () => {
    const bucket = Rollup.sessionToDailyBucket(digest())
    expect(bucket).toEqual({
      day: "2026-01-05",
      sessions: 1,
      turns: 4,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
      cost: 0.25,
      additions: 30,
      deletions: 10,
      files: 3,
      toolCalls: 7,
      errors: 1,
    })
  })
})

import { expect, test } from "bun:test"
import { UsageQuery } from "../../src/usage/query"
import { UsageSchema } from "../../src/usage/schema"
import { RolloutUsage } from "../../src/session/rollout/usage"

const owner = { kind: "session" as const, scopeID: "scope", sessionID: "session" }
const base = {
  version: 1 as const,
  id: "call",
  entityID: "call",
  owner,
  runID: "run",
  revision: 1,
  sourceRevision: 1,
  source: "local" as const,
  status: "completed" as const,
  started: Date.parse("2026-09-27T15:00:00Z"),
  ended: Date.parse("2026-09-27T15:01:00Z"),
}
const model = {
  providerID: "p",
  modelID: "m",
  sdk: "@ai-sdk/anthropic",
  pricing: null,
  billingMode: "api" as const,
  limits: { context: 2000, output: 500 },
}
function facts(
  input: { uncached?: number; read?: number; write?: number; started?: number } = {},
): UsageSchema.Record[] {
  const usage = RolloutUsage.normalize("anthropic", {
    input_tokens: input.uncached ?? 100,
    cache_read_input_tokens: input.read ?? 800,
    cache_creation_input_tokens: input.write ?? 100,
    output_tokens: 500,
  })
  const attribution = {
    purpose: "synergy",
    usageRole: "conversation" as const,
    model,
    execution: "provider" as const,
    callKind: "chat" as const,
  }
  return [
    { ...base, ...attribution, kind: "call", hasAttempts: true },
    {
      ...base,
      ...attribution,
      kind: "attempt",
      id: "attempt",
      entityID: "attempt",
      callID: "call",
      index: 0,
      usage,
      usageFinal: true,
      timing: {
        source: "transport",
        sentAt: input.started ?? base.started,
        contentEvents: 2,
        reasoningObserved: false,
        streaming: true,
        requestMs: 1000,
        generationMs: 900,
      },
    },
  ]
}

test("cache uses all input and reasoning is not additive", () => {
  const summary = UsageQuery.summarize(facts())
  expect(summary.cache.ratio).toBe(0.8)
  expect(summary.accounting.tokens.total.total).toBe(1500)
  expect(summary.context).toMatchObject({ inputTokens: 1000, ratio: 0.5 })
})

test("journal gaps retain uncertainty without counting as legacy evidence", () => {
  const summary = UsageQuery.summarize([
    ...facts(),
    { ...base, id: "legacy-tool", source: "legacy", kind: "tool", tool: "read", durationMs: 1 },
    { ...base, id: "gap", source: "legacy", kind: "gap", runID: "unattributed", sequence: 1 },
  ])
  expect(summary.coverage.legacy).toBe(1)
  expect(summary.coverage.records).toBe(4)
  expect(summary.accounting.journalGaps).toBe(1)
  expect(summary.accounting.tokens.total.known).toBe(1500)
  expect(summary.accounting.tokens.total.total).toBeNull()
})

test("request-day attribution respects IANA timezones rather than call or session creation", () => {
  const records = facts({ started: Date.parse("2026-09-27T16:30:00Z") })
  expect(UsageQuery.summarize(records, { timezone: "Asia/Shanghai" }).daily.map((day) => day.date)).toEqual([
    "2026-09-28",
  ])
  expect(UsageQuery.summarize(records, { timezone: "America/New_York" }).daily.map((day) => day.date)).toEqual([
    "2026-09-27",
  ])
})

test("tool averages combine measured duration and sample count, independent of order", () => {
  const records: UsageSchema.Record[] = [100, 100, 300, 300].map((durationMs, index) => ({
    ...base,
    id: String(index),
    entityID: String(index),
    kind: "tool",
    tool: "read",
    durationMs,
  }))
  records.push({
    ...base,
    id: "interrupted",
    entityID: "interrupted",
    kind: "tool",
    tool: "read",
    status: "interrupted",
    ended: undefined,
    durationMs: null,
  })
  expect(UsageQuery.summarize(records).tools[0]).toMatchObject({
    calls: 5,
    timedSamples: 4,
    durationMs: 800,
    averageMs: 200,
  })
  expect(UsageQuery.summarize(records.toReversed()).tools).toEqual(UsageQuery.summarize(records).tools)
})

test("provisional usage is separate and imported records are not local spend", () => {
  const records = facts().map((record) =>
    record.kind === "attempt" ? { ...record, status: "running" as const, usageFinal: false } : record,
  )
  const summary = UsageQuery.summarize(records)
  expect(summary.accounting.tokens.total.total).toBeNull()
  expect(summary.provisional.tokens.total.known).toBe(1500)
  const imported = UsageQuery.summarize(facts().map((record) => ({ ...record, source: "imported" })))
  expect(imported.accounting.tokens.total.known).toBe(0)
  expect(imported.accounting.importedCalls).toBe(1)
})

test("active transport replaces its queued call phase and context uses the usable input limit", () => {
  const records = facts().map((record) => ({
    ...record,
    model: { ...model, limits: { ...model.limits, input: 1500 } },
    status: "running" as const,
  }))
  const result = UsageQuery.summarize(records)
  expect(result.phases).toHaveLength(1)
  expect(result.phases[0].phase).toBe("request")
  expect(result.context?.limit).toBe(1500)
})

test("custom conversation agents retain their latest request context", () => {
  const records = facts().map((record) => ({ ...record, purpose: "custom-primary", agent: "custom-primary" }))
  expect(UsageQuery.summarize(records).context).toMatchObject({ inputTokens: 1000, modelID: "m" })
})

test("descendant requests and compactions cannot replace or invalidate a selected owner's context", () => {
  const records = facts()
  const child = facts({ started: base.started + 1000 }).map((record) => ({
    ...record,
    id: `child-${record.id}`,
    entityID: `child-${record.entityID}`,
    owner: { ...owner, sessionID: "child" },
    runID: "child-run",
  }))
  const compaction = {
    ...child[0],
    started: base.started + 2000,
    purpose: "compaction",
    usageRole: "compaction" as const,
  }
  const summary = UsageQuery.summarize([...records, ...child, compaction], { sessionID: owner.sessionID })
  expect(summary.context).toMatchObject({ attemptID: "attempt", stale: false })
  expect(UsageQuery.summarize(child, { sessionID: owner.sessionID }).context).toBeNull()
  expect(UsageQuery.summarize([...records, ...child], { runID: "run" }).context?.attemptID).toBe("attempt")
  expect(UsageQuery.summarize([...records, { ...compaction, owner }]).context?.stale).toBe(true)
  expect(UsageQuery.summarize([...records, { ...compaction, owner, source: "imported" }]).context?.stale).toBe(false)
})

test("auxiliary and historically unclassified calls cannot supply conversation context", () => {
  for (const usageRole of ["auxiliary", undefined] as const) {
    const records = facts().map((record) => ({ ...record, usageRole }))
    expect(UsageQuery.summarize(records).context).toBeNull()
    expect(UsageQuery.summarize(records).accounting.tokens.total.total).toBe(1500)
  }
})

test("a filtered-out retry cannot resurrect SDK totals on its parent call", () => {
  const call = facts()[0]
  if (call.kind !== "call") throw new Error("fixture")
  const result = UsageQuery.summarize([
    { ...call, usage: RolloutUsage.normalizeSdk({ inputTokens: 999, outputTokens: 1 }, "openai")! },
  ])
  expect(result.accounting.tokens.total.known).toBe(0)
})

test("final SDK usage never reappears as provisional spending", () => {
  const call = facts()[0]
  if (call.kind !== "call") throw new Error("fixture")
  const result = UsageQuery.summarize([
    {
      ...call,
      hasAttempts: false,
      usage: RolloutUsage.normalizeSdk({ inputTokens: 10, outputTokens: 2 }, "openai")!,
      estimate: { version: 1, basis: "api_price_estimate", currency: "USD", known: 1, total: 1, missing: [] },
    },
  ])
  expect(result.accounting.tokens.total.total).toBe(12)
  expect(result.provisional.calls).toBe(0)
  expect(result.provisional.apiEstimate.known).toBe(0)
})

test("dispatch and between-attempt gaps do not enter model request or generation time", () => {
  const records = facts({ started: base.started + 100 })
  const attempt = records[1]
  if (attempt.kind !== "attempt") throw new Error("fixture")
  attempt.timing = { ...attempt.timing!, endedAt: base.started + 1100 }
  records.push({
    ...attempt,
    id: "retry",
    entityID: "retry",
    index: 1,
    timing: { ...attempt.timing!, sentAt: base.started + 1600 },
  })
  const result = UsageQuery.summarize(records)
  expect(result.scheduling.dispatch.meanMs).toBe(100)
  expect(result.scheduling.betweenAttempts.meanMs).toBe(500)
  expect(result.latency.request.totalMs).toBe(2000)
})

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, statSync } from "fs"
import { ObservabilityClock } from "../../src/observability/clock"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityContext } from "../../src/observability/context"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityDbWrites } from "../../src/observability/db-writes"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityLiveEvents } from "../../src/observability/live-events"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityRedaction } from "../../src/observability/redaction"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilitySchema } from "../../src/observability/schema"
import { ObservabilityStore } from "../../src/observability/store"
import { clearObservabilityState, resetObservabilityState } from "./fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("ObservabilityStore", () => {
  beforeEach(() => runtime.run(() => resetObservabilityState()))
  afterEach(() => runtime.run(() => clearObservabilityState()))

  test("creates obs tables and queries by trace, correlation, and session", () =>
    runtime.run(async () => {
      await ObservabilityEvents.emit("test.event", {
        traceId: "trace_1",
        correlationId: "corr_1",
        sessionID: "ses_1",
        data: { safe: "ok" },
      })
      ObservabilityMetrics.record({
        name: "test.metric",
        value: 1,
        unit: "count",
        module: "observability",
        traceId: "trace_1",
        correlationId: "corr_1",
        sessionID: "ses_1",
      })
      await ObservabilityResources.snapshot({ role: "server" })
      ObservabilityIssues.raise({
        code: "PERF_TEST_STORE",
        severity: "warning",
        module: "observability",
        title: "Store issue",
        message: "Store issue",
        traceId: "trace_1",
        correlationId: "corr_1",
        sessionID: "ses_1",
      })
      ObservabilityStore.flush()

      expect(ObservabilityStore.queryEvents({ traceId: "trace_1" })).toHaveLength(1)
      expect(ObservabilityStore.queryEvents({ correlationId: "corr_1" })).toHaveLength(1)
      expect(ObservabilityStore.queryEvents({ sessionID: "ses_1" })).toHaveLength(1)
      expect(
        ObservabilityStore.queryMetrics({ since: 0, correlationId: "corr_1" }).some(
          (row) => row.name === "test.metric",
        ),
      ).toBe(true)
      expect(
        ObservabilityIssues.list({ module: "observability" }).some((issue) => issue.code === "PERF_TEST_STORE"),
      ).toBe(true)
      expect(ObservabilityStore.resourceSince(0).length).toBeGreaterThan(0)
      expect(new Set(ObservabilityStore.meta().map((row) => row.key))).toContain("schemaVersion")
    }))

  test("aggregates process output characters within one flush window", () =>
    runtime.run(() => {
      for (let index = 0; index < 10; index++) {
        ObservabilityMetrics.record({
          name: "process.output.chars",
          value: 10,
          unit: "count",
          module: "process",
          source: "process",
          processId: "proc_aggregate",
        })
      }
      ObservabilityStore.flush()

      const rows = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["process.output.chars"],
        newestFirst: true,
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe(100)
    }))

  test("storage queue depth retains the last value and peak without sharding by request", () =>
    runtime.run(() => {
      let now = Math.ceil(performance.now())
      using clock = spyOn(performance, "now").mockImplementation(() => now)
      const rowsForQueue = () =>
        ObservabilityStore.queryMetrics({
          since: 0,
          names: ["storage.queue.depth", "storage.queue.depth.peak"],
        }).filter((row) => JSON.parse(row.labels_json).queue === "test-reader")
      for (const [index, value] of [1, 7, 3, 0].entries()) {
        ObservabilityMetrics.record({
          name: "storage.queue.depth",
          value,
          unit: "count",
          module: "storage",
          labels: { queue: "test-reader" },
          sessionID: `session-${index}`,
          scopeID: `scope-${index}`,
          traceId: `trace-${index}`,
        })
      }
      ObservabilityStore.flush()
      expect(rowsForQueue()).toHaveLength(0)
      now += 1_000
      ObservabilityStore.flush()
      const rows = rowsForQueue()
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.name === "storage.queue.depth")?.value).toBe(0)
      expect(rows.find((row) => row.name === "storage.queue.depth.peak")?.value).toBe(7)
      expect(rows.every((row) => !row.session_id && !row.trace_id && !row.scope_id)).toBe(true)
    }))

  test("collapses aggregated counters that differ only in per-turn identity", () =>
    runtime.run(() => {
      const identity = [
        { sessionID: "ses_collapse_a", messageID: "msg_collapse_a", callID: "call_collapse_a" },
        { sessionID: "ses_collapse_b", messageID: "msg_collapse_b", callID: "call_collapse_b" },
      ]
      identity.forEach((fields, index) => {
        ObservabilityMetrics.record({
          name: "storage.operation.count",
          value: 1,
          unit: "count",
          module: "storage",
          labels: { operation: "read" },
          traceId: `trace_collapse_${index}`,
          spanId: `span_collapse_${index}`,
          correlationId: `corr_collapse_${index}`,
          processId: `proc_collapse_${index}`,
          pid: 100 + index,
          ...fields,
        })
      })
      ObservabilityStore.flush()

      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["storage.operation.count"] })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe(2)
    }))

  test("keeps aggregated counters separate per scope and tool", () =>
    runtime.run(() => {
      const groups = [
        { scopeID: "scope_keep_a", tool: "bash" },
        { scopeID: "scope_keep_b", tool: "bash" },
        { scopeID: "scope_keep_b", tool: "read" },
      ]
      for (const group of groups) {
        ObservabilityMetrics.record({
          name: "process.output.chars",
          value: 5,
          unit: "count",
          module: "process",
          source: "process",
          ...group,
        })
      }
      ObservabilityStore.flush()

      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["process.output.chars"] })
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.value)).toEqual([5, 5, 5])
    }))

  test("keeps per-session rows for metrics outside the aggregated counter family", () =>
    runtime.run(() => {
      for (const sessionID of ["ses_keep_a", "ses_keep_b"]) {
        ObservabilityMetrics.record({
          name: "http.request.duration",
          value: 1,
          unit: "ms",
          module: "server",
          sessionID,
        })
      }
      ObservabilityStore.flush()

      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["http.request.duration"] })
      expect(rows.map((row) => row.session_id).sort()).toEqual(["ses_keep_a", "ses_keep_b"])
    }))

  test("keeps agent queue lane and pool source labels addressable in the store", () =>
    runtime.run(() => {
      for (const lane of ["interactive", "background"]) {
        ObservabilityMetrics.record({
          name: "agent.queue.depth",
          value: lane === "interactive" ? 2 : 1,
          unit: "count",
          module: "session",
          labels: { lane },
        })
        ObservabilityMetrics.record({
          name: "agent.queue.wait",
          value: lane === "interactive" ? 12 : 240,
          unit: "ms",
          module: "session",
          labels: { lane },
        })
      }
      ObservabilityMetrics.record({
        name: "agent.pool.size",
        value: 20,
        unit: "count",
        module: "session",
        labels: { source: "derived" },
      })
      ObservabilityStore.flush()

      const depth = ObservabilityStore.queryMetrics({ since: 0, names: ["agent.queue.depth"] })
      expect(depth).toHaveLength(2)
      const depthByLane = new Map(depth.map((row) => [JSON.parse(row.labels_json).lane as string, row.value]))
      expect(depthByLane.get("interactive")).toBe(2)
      expect(depthByLane.get("background")).toBe(1)

      const wait = ObservabilityStore.queryMetrics({ since: 0, names: ["agent.queue.wait"] })
      expect(wait).toHaveLength(2)
      expect(new Set(wait.map((row) => JSON.parse(row.labels_json).lane))).toEqual(
        new Set(["interactive", "background"]),
      )

      const pool = ObservabilityStore.queryMetrics({ since: 0, names: ["agent.pool.size"] })
      expect(pool).toHaveLength(1)
      expect(JSON.parse(pool[0]!.labels_json).source).toBe("derived")
      expect(pool[0]!.value).toBe(20)
    }))

  test("defaults the log mirror switch to off and honors an explicit opt-in", () =>
    runtime.run(() => {
      expect(ObservabilityConfig.logMirror()).toBe(false)

      ObservabilityConfig.refresh({ observability: { logMirror: true } })
      expect(ObservabilityConfig.logMirror()).toBe(true)

      ObservabilityConfig.refresh()
      expect(ObservabilityConfig.logMirror()).toBe(false)
    }))

  test("ignores JSONL-only mirror files in indexed runtime query", () =>
    runtime.run(async () => {
      const fs = await import("fs/promises")
      const path = await import("path")
      const traceDir = path.join(process.env.SYNERGY_TEST_HOME!, "state", "observability", "traces")
      await fs.mkdir(traceDir, { recursive: true })
      await fs.writeFile(
        path.join(traceDir, "2026-01-01.jsonl"),
        JSON.stringify({ type: "jsonl.only", traceId: "trace_jsonl" }) + "\n",
      )

      expect(ObservabilityStore.queryEvents({ traceId: "trace_jsonl" })).toEqual([])
    }))

  test("refreshes an open aggregate with the latest observation while retaining its lifetime", () =>
    runtime.run(() => {
      let now = Date.now()
      using clock = spyOn(ObservabilityClock, "now").mockImplementation(() => now)
      const first = ObservabilityIssues.raise({
        code: "PERF_TEST_DEDUPE",
        severity: "warning",
        module: "observability",
        title: "First issue",
        message: "First observation",
        recommendation: "First recommendation",
        traceId: "trace_1",
        spanId: "span_1",
        correlationId: "corr_1",
        scopeID: "scope_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
        rid: "request_1",
        fingerprint: "owner:aggregate",
        evidence: { observedValue: 100 },
      })!
      now += 100
      const latest = {
        code: "PERF_TEST_DEDUPE",
        severity: "critical" as const,
        module: "observability" as const,
        title: "Latest issue",
        message: "Latest observation",
        recommendation: "Latest recommendation",
        traceId: "trace_2",
        spanId: "span_2",
        correlationId: "corr_2",
        scopeID: "scope_2",
        sessionID: "ses_2",
        messageID: "msg_2",
        callID: "call_2",
        rid: "request_2",
        fingerprint: "owner:aggregate",
        evidence: { observedValue: 200 },
      }
      ObservabilityIssues.raise(latest)

      const issues = ObservabilityIssues.list({ module: "observability" }).filter(
        (issue) => issue.code === "PERF_TEST_DEDUPE",
      )

      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({
        ...latest,
        issueId: first.issueId,
        time: first.time,
        iso: first.iso,
        firstSeenTime: first.firstSeenTime,
        lastSeenTime: now,
        occurrenceCount: 2,
        evidence: { observedValue: 200, latestTraceId: "trace_2", latestCallID: "call_2" },
      })
    }))

  test("groups default issues by ambient Scope without splitting Sessions or calls", () =>
    runtime.run(() => {
      const input = {
        code: "PERF_TEST_SCOPE",
        severity: "warning" as const,
        module: "observability" as const,
        title: "Scope issue",
        message: "Scope observation",
        scopeID: undefined,
      }
      for (const [scopeID, sessionID, callID] of [
        ["scope_a", "ses_1", "call_1"],
        ["scope_a", "ses_2", "call_2"],
        ["scope_b", "ses_3", "call_3"],
      ]) {
        ObservabilityContext.withContext({ scopeID, sessionID, callID }, () => ObservabilityIssues.raise(input))
      }
      ObservabilityIssues.raise(input)

      const issues = ObservabilityIssues.list({ module: "observability" })
      expect(issues).toHaveLength(3)
      expect(new Set(issues.map((issue) => issue.fingerprint)).size).toBe(3)
      expect(ObservabilityIssues.list({ scopeID: "scope_a" })).toMatchObject([
        { scopeID: "scope_a", sessionID: "ses_2", callID: "call_2", occurrenceCount: 2 },
      ])
      expect(ObservabilityIssues.list({ scopeID: "scope_b" })).toMatchObject([
        { scopeID: "scope_b", occurrenceCount: 1 },
      ])
      expect(issues.find((issue) => issue.scopeID === undefined)?.occurrenceCount).toBe(1)
    }))

  test("adds the complete observation delta when an issue aggregate is upserted", () =>
    runtime.run(() => {
      const first = ObservabilityIssues.raise({
        code: "PERF_TEST_DELTA",
        severity: "warning",
        module: "process",
        title: "Delta",
        message: "First observation",
      })!
      ObservabilityStore.insertIssue({ ...first, issueId: "delta-batch", occurrenceCount: 9 })
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([{ occurrenceCount: 10 }])
    }))

  test("coalesces condition observations before redaction and writes one exact delta per batch", () =>
    runtime.run(() => {
      let now = Date.now()
      using clock = spyOn(ObservabilityClock, "now").mockImplementation(() => now)
      using writes = spyOn(ObservabilityDbWrites, "insertIssue")
      using redactions = spyOn(ObservabilityRedaction, "redactRecord")
      using parses = spyOn(ObservabilitySchema.Issue, "parse")
      for (let index = 0; index < 1000; index++) {
        ObservabilityIssues.raise({
          code: "PERF_TEST_DISCRETE_WORK",
          module: "process",
          severity: "warning",
          title: "Discrete error",
          message: "Independent error observation",
          scopeID: "discrete_work",
        })
      }
      expect(parses).toHaveBeenCalledTimes(1000)
      expect(ObservabilityIssues.list({ scopeID: "discrete_work" })).toMatchObject([{ occurrenceCount: 1000 }])
      expect(writes).toHaveBeenCalledTimes(1000)
      expect(redactions).toHaveBeenCalledTimes(1000)
      writes.mockClear()
      redactions.mockClear()
      parses.mockClear()
      const events: ObservabilityLiveEvents.Event[] = []
      const unsubscribe = ObservabilityLiveEvents.subscribe((event) => events.push(event))
      const input = {
        code: "PERF_TEST_CONDITION_BATCH",
        owner: "control-plane" as const,
        module: "process" as const,
        title: "Resource pressure",
        severity: "warning" as const,
        state: "active" as const,
        thresholdValue: 100,
        unit: "bytes" as const,
        scopeID: "condition_batch",
      }
      try {
        const firstTime = now
        for (let index = 0; index < 1000; index++) {
          ObservabilityContext.withContext({ sessionID: `session_${index}`, traceId: `trace_${index}` }, () =>
            ObservabilityIssues.observeCondition({ ...input, observedValue: index === 500 ? 2000 : 100 + index }),
          )
          now++
        }
        expect(events).toHaveLength(1)
        expect(parses).toHaveBeenCalledTimes(1)
        const [first] = ObservabilityIssues.list({ scopeID: input.scopeID })
        expect(first).toMatchObject({
          occurrenceCount: 1000,
          firstSeenTime: firstTime,
          lastSeenTime: now - 1,
          sessionID: "session_999",
          traceId: "trace_999",
          evidence: {
            firstObservedValue: 100,
            observedValue: 1099,
            peakObservedValue: 2000,
            peakObservedTime: firstTime + 500,
          },
        })
        expect(writes).toHaveBeenCalledTimes(1)
        expect(redactions.mock.calls.length).toBeLessThanOrEqual(2)
        expect(parses).toHaveBeenCalledTimes(3)
        ObservabilityIssues.observeCondition({ ...input, observedValue: 105 })
        const [second] = ObservabilityIssues.list({ scopeID: input.scopeID })
        expect(second).toMatchObject({
          issueId: first.issueId,
          occurrenceCount: 1001,
          firstSeenTime: firstTime,
          lastSeenTime: now,
          evidence: { firstObservedValue: 100, observedValue: 105, peakObservedValue: 2000 },
        })
        expect(second.sessionID).toBeUndefined()
        expect(second.traceId).toBeUndefined()
        expect(writes).toHaveBeenCalledTimes(2)
        expect(events[0]).toMatchObject({
          type: "issue.raised",
          issue: { occurrenceCount: 1, evidence: { observedValue: 100 } },
        })
      } finally {
        unsubscribe()
      }
    }))

  test("resolves only a healthy owner and starts a new episode even within one batch", () =>
    runtime.run(() => {
      const input = {
        code: "PERF_TEST_CONDITION_EPISODES",
        owner: "control-plane" as const,
        module: "process" as const,
        title: "Resource pressure",
        severity: "warning" as const,
        state: "active" as const,
        thresholdValue: 100,
        observedValue: 120,
        unit: "bytes" as const,
        scopeID: "episode_scope_a",
      }
      ObservabilityIssues.observeCondition(input)
      ObservabilityIssues.observeCondition({ ...input, observedValue: 160 })
      ObservabilityIssues.observeCondition({ ...input, owner: "agent-pool" })
      ObservabilityIssues.observeCondition({ ...input, scopeID: "episode_scope_b" })
      ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 40 })
      ObservabilityIssues.observeCondition({ ...input, observedValue: 130 })
      const open = ObservabilityIssues.list({ module: "process" })
      expect(open).toHaveLength(3)
      const resolved = ObservabilityIssues.list({ status: "resolved", scopeID: input.scopeID })
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({
        occurrenceCount: 2,
        evidence: { peakObservedValue: 160, recoveryObservedValue: 40 },
      })
      const reentered = open.find((issue) => issue.scopeID === input.scopeID && issue.evidence.owner === input.owner)!
      expect(reentered.issueId).not.toBe(resolved[0].issueId)
      expect(reentered).toMatchObject({
        occurrenceCount: 1,
        evidence: { firstObservedValue: 130, peakObservedValue: 130 },
      })
    }))

  test("keeps unknown or invalid readings open and publishes severity escalation immediately", () =>
    runtime.run(() => {
      const input = {
        code: "PERF_TEST_CONDITION_UNKNOWN",
        owner: "service" as const,
        module: "process" as const,
        title: "Service pressure",
        severity: "warning" as const,
        state: "active" as const,
        thresholdValue: 100,
        observedValue: 120,
        unit: "bytes" as const,
        scopeID: "condition_unknown",
      }
      const events: ObservabilityLiveEvents.Event[] = []
      const unsubscribe = ObservabilityLiveEvents.subscribe((event) => events.push(event))
      try {
        ObservabilityIssues.observeCondition(input)
        ObservabilityIssues.observeCondition({ ...input, state: "unknown" })
        ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: Number.NaN })
        expect(ObservabilityIssues.list({ scopeID: input.scopeID })).toMatchObject([
          { occurrenceCount: 1, status: "open" },
        ])
        ObservabilityIssues.observeCondition({ ...input, severity: "critical", observedValue: 300 })
        expect(events).toHaveLength(2)
        expect(events[1]).toMatchObject({ type: "issue.raised", issue: { severity: "critical" } })
        ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 20 })
        expect(events[2]).toMatchObject({ type: "issue.resolved", issue: { status: "resolved", occurrenceCount: 2 } })
        expect(ObservabilityIssues.list({ scopeID: input.scopeID })).toEqual([])
      } finally {
        unsubscribe()
      }
    }))

  test("drains a pending condition delta on stop", async () => {
    await using independent = await testRuntime()
    await independent.run(async () => {
      const input = {
        code: "PERF_TEST_CONDITION_STOP",
        owner: "control-plane" as const,
        module: "process" as const,
        title: "Stop pressure",
        severity: "warning" as const,
        state: "active" as const,
        thresholdValue: 100,
        observedValue: 120,
        unit: "bytes" as const,
      }
      ObservabilityIssues.observeCondition(input)
      ObservabilityIssues.observeCondition(input)
      const filename = ObservabilityStore.pathName()
      await ObservabilityStore.stop()
      const { Database } = await import("bun:sqlite")
      using reader = new Database(filename, { readonly: true })
      expect(reader.query("SELECT occurrence_count FROM obs_issues WHERE code = ?").get(input.code)).toEqual({
        occurrence_count: 2,
      })
    })
  })

  test("keeps one condition write per owner when owners first appear in the same batch", () =>
    runtime.run(() => {
      using writes = spyOn(ObservabilityDbWrites, "insertIssue")
      const input = {
        code: "PERF_TEST_PARALLEL_OWNERS",
        owner: "control-plane" as const,
        module: "process" as const,
        title: "Parallel owners",
        severity: "warning" as const,
        state: "active" as const,
        observedValue: 120,
        thresholdValue: 100,
        unit: "bytes" as const,
      }
      for (let index = 0; index < 1000; index++) {
        ObservabilityIssues.observeCondition({ ...input, scopeID: "parallel_a" })
        ObservabilityIssues.observeCondition({ ...input, scopeID: "parallel_a", owner: "agent-pool" })
        ObservabilityIssues.observeCondition({ ...input, scopeID: "parallel_b" })
      }
      const issues = ObservabilityIssues.list({ module: "process" })
      expect(issues).toHaveLength(3)
      expect(issues.every((issue) => issue.occurrenceCount === 1000)).toBe(true)
      expect(writes).toHaveBeenCalledTimes(3)
    }))

  test("retains an open condition across Runtime reopen until healthy evidence arrives", async () => {
    const home = `${runtime.host.home}/condition-reopen`
    const input = {
      code: "PERF_TEST_CONDITION_REOPEN",
      owner: "control-plane" as const,
      module: "process" as const,
      title: "Retained pressure",
      severity: "warning" as const,
      state: "active" as const,
      observedValue: 200,
      thresholdValue: 100,
      unit: "bytes" as const,
    }
    const initial = await testRuntime({ home })
    let first: ReturnType<typeof ObservabilityIssues.list>[number]
    try {
      first = initial.run(() => {
        ObservabilityIssues.observeCondition(input)
        return ObservabilityIssues.list({ module: "process" })[0]
      })
    } finally {
      await initial.close()
    }
    await using reopened = await testRuntime({ home })
    reopened.run(() => {
      ObservabilityIssues.observeCondition({ ...input, observedValue: 130 })
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([
        {
          issueId: first.issueId,
          occurrenceCount: 2,
          firstSeenTime: first.firstSeenTime,
          evidence: { firstObservedValue: 200, peakObservedValue: 200, observedValue: 130 },
        },
      ])
      ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 20 })
      expect(ObservabilityIssues.list({ module: "process" })).toEqual([])
      expect(ObservabilityIssues.list({ status: "resolved", module: "process" })).toMatchObject([
        { issueId: first.issueId, occurrenceCount: 2 },
      ])
    })
  })

  test("accounts for observation weight when the inline queue overflows or its transaction rolls back", () =>
    runtime.run(() => {
      const first = ObservabilityIssues.raise({
        code: "PERF_TEST_INLINE_WEIGHT",
        module: "process",
        severity: "warning",
        title: "Inline weight",
        message: "Inline weight",
      })!
      ObservabilityStore.flush()
      const dropped = ObservabilityStore.stats().dropped
      for (let index = 0; index < 10_001; index++) ObservabilityStore.insertIssue({ ...first, occurrenceCount: 7 })
      expect(ObservabilityStore.stats()).toMatchObject({ pending: 9001, dropped: dropped + 7000 })
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([{ occurrenceCount: 63_008 }])
      const conn = ObservabilityStore.open()!
      conn.exec(
        "CREATE TRIGGER reject_issue BEFORE UPDATE ON obs_issues BEGIN SELECT RAISE(ABORT, 'rejected inline batch'); END",
      )
      try {
        ObservabilityStore.insertIssue({ ...first, occurrenceCount: 7 })
        ObservabilityStore.flush()
        expect(ObservabilityStore.stats().dropped).toBe(dropped + 7007)
        expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([{ occurrenceCount: 63_008 }])
      } finally {
        conn.exec("DROP TRIGGER reject_issue")
      }
    }))

  test("queryMetrics newestFirst returns rows in descending time order without JS reversal", () =>
    runtime.run(() => {
      // Insert metrics sequentially with delay to get distinct timestamps
      ObservabilityMetrics.record({ name: "test.sort.a", value: 1, unit: "count", module: "observability" })
      Bun.sleepSync(5)
      ObservabilityMetrics.record({ name: "test.sort.b", value: 2, unit: "count", module: "observability" })
      Bun.sleepSync(5)
      ObservabilityMetrics.record({ name: "test.sort.c", value: 3, unit: "count", module: "observability" })

      const newest = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["test.sort.a", "test.sort.b", "test.sort.c"],
        limit: 3,
        newestFirst: true,
      })
      expect(newest).toHaveLength(3)
      // newestFirst must return in DESC order — latest first
      expect(newest[0].name).toBe("test.sort.c")
      expect(newest[1].name).toBe("test.sort.b")
      expect(newest[2].name).toBe("test.sort.a")

      const oldest = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["test.sort.a", "test.sort.b", "test.sort.c"],
        limit: 3,
        newestFirst: false,
      })
      expect(oldest).toHaveLength(3)
      expect(oldest[0].name).toBe("test.sort.a")
      expect(oldest[1].name).toBe("test.sort.b")
      expect(oldest[2].name).toBe("test.sort.c")
    }))

  test("closing an unopened store drains queued metrics without leaving maintenance timers", () =>
    runtime.run(() => {
      expect(ObservabilityStore.stats().available).toBe(false)
      ObservabilityMetrics.record({
        name: "test.close.lazy",
        value: 7,
        unit: "count",
        module: "observability",
      })
      expect(ObservabilityStore.stats().pending).toBeGreaterThan(0)

      ObservabilityStore.close()

      expect(ObservabilityStore.stats()).toMatchObject({
        available: false,
        pending: 0,
        checkpointIntervalMs: undefined,
        retentionIntervalMs: undefined,
      })
      expect(ObservabilityStore.queryMetrics({ since: 0, names: ["test.close.lazy"] }).map((row) => row.value)).toEqual(
        [7],
      )
    }))

  test("compact timer is created on open and cleared on close", () =>
    runtime.run(() => {
      const conn = ObservabilityStore.open()
      expect(conn).toBeDefined()
      ObservabilityStore.close()
      const reopened = ObservabilityStore.open()
      expect(reopened).toBeDefined()
      ObservabilityStore.close()
    }))

  test("checkpoints and truncates the WAL on graceful close", () =>
    runtime.run(async () => {
      for (let index = 0; index < 100; index++) {
        ObservabilityMetrics.record({
          name: "test.close.checkpoint",
          value: index,
          unit: "count",
          module: "observability",
        })
      }
      ObservabilityStore.flush()
      const walPath = `${ObservabilityStore.pathName()}-wal`
      expect(Bun.file(walPath).size).toBeGreaterThan(0)

      ObservabilityStore.close()

      const walSize = (await Bun.file(walPath).exists()) ? Bun.file(walPath).size : 0
      expect(walSize).toBe(0)
    }))

  test("queryIssues finds issues by evidence_json scopeID fallback", () =>
    runtime.run(() => {
      ObservabilityIssues.raise({
        code: "PERF_TEST_EVIDENCE_SCOPE",
        severity: "warning",
        module: "observability",
        title: "Evidence scope issue",
        message: "Has scopeID only in evidence",
        evidence: { scopeID: "sc_via_evidence" },
      })
      ObservabilityStore.flush()

      const issues = ObservabilityIssues.list({ scopeID: "sc_via_evidence" })
      expect(issues).toHaveLength(1)
      expect(issues[0].code).toBe("PERF_TEST_EVIDENCE_SCOPE")
      expect(issues[0].scopeID).toBeUndefined()
      expect(issues[0].evidence.scopeID).toBe("sc_via_evidence")
    }))
  test("retain runs without errors and writes meta timestamp", () =>
    runtime.run(() => {
      ObservabilityMetrics.record({
        name: "retain.test.metric",
        value: 1,
        unit: "count",
        module: "observability",
      })
      ObservabilityStore.flush()

      ObservabilityStore.retain()

      const meta = ObservabilityStore.meta()
      const retentionEntry = meta.find((row) => row.key === "lastRetentionRunAt")
      expect(retentionEntry).toBeDefined()
      const timestamp = Number(retentionEntry!.value)
      expect(timestamp).toBeGreaterThan(0)
      expect(timestamp).toBeGreaterThan(Date.now() - 10_000)
    }))

  test(
    "keeps the physical database footprint under the configured cap without deleting newest data",
    () =>
      runtime.run(async () => {
        const maxSqliteBytes = 1024 * 1024
        ObservabilityConfig.refresh({
          observability: { performance: { storage: { maxSqliteBytes } } },
        })
        for (let index = 0; index < 6_000; index++) {
          ObservabilityMetrics.record({
            name: "test.capacity.metric",
            value: index,
            unit: "count",
            module: "observability",
            labels: { payload: `${index}:${"x".repeat(1000)}` },
          })
        }
        ObservabilityStore.flush()

        for (let pass = 0; pass < 20 && ObservabilityStore.stats().maintenanceDeferred; pass++) {
          await Bun.sleep(0)
          ObservabilityStore.retain()
        }
        expect(ObservabilityStore.stats().maintenanceDeferred).toBe(false)
        const filepath = ObservabilityStore.pathName()
        const physicalBytes = [filepath, `${filepath}-wal`, `${filepath}-shm`].reduce((total, file) => {
          try {
            return total + statSync(file).size
          } catch {
            return total
          }
        }, 0)
        const rows = ObservabilityStore.queryMetrics({
          since: 0,
          names: ["test.capacity.metric"],
          newestFirst: true,
          limit: 10_000,
        })
        expect(physicalBytes).toBeLessThanOrEqual(maxSqliteBytes)
        expect(rows.length).toBeGreaterThan(0)
        expect(rows[0].value).toBe(5_999)
      }),
    15000,
  )

  test("fails open when the observability database cannot be created", () =>
    runtime.run(() => {
      ObservabilityStore.close()
      mkdirSync(ObservabilityStore.pathName(), { recursive: true })

      expect(ObservabilityStore.open()).toBeUndefined()
      expect(ObservabilityStore.stats().available).toBe(false)
      expect(ObservabilityStore.stats().lastOpenError).toBeTruthy()
    }))
})

test("stats reports pending queue length and dropped job count", () =>
  runtime.run(() => {
    const initial = ObservabilityStore.stats()
    expect(initial).toHaveProperty("pending")
    expect(initial).toHaveProperty("dropped")
    expect(initial.dropped).toBeGreaterThanOrEqual(0)
    expect(initial.pending).toBeGreaterThanOrEqual(0)

    ObservabilityMetrics.record({
      name: "stats.test",
      value: 1,
      unit: "count",
      module: "observability",
    })
    const afterEnqueue = ObservabilityStore.stats()
    expect(afterEnqueue.pending).toBeGreaterThan(initial.pending)
  }))

test("queues retention after open and runs it on flush", () =>
  runtime.run(() => {
    ObservabilityStore.flush()
    const meta = ObservabilityStore.meta()
    expect(meta.some((row) => row.key === "lastRetentionRunAt")).toBe(true)
    expect(Number(meta.find((row) => row.key === "lastRetentionRunAt")!.value)).toBeGreaterThan(0)
  }))

afterRuntimeTests(() => runtime.close())

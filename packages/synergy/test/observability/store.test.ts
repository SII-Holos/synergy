import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilityStore } from "../../src/observability/store"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("ObservabilityStore", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => cleanupObservabilityHomes())

  test("creates obs tables and queries by trace, correlation, and session", async () => {
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
    ObservabilityResources.snapshot({ role: "server" })
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
      ObservabilityStore.queryMetrics({ since: 0, correlationId: "corr_1" }).some((row) => row.name === "test.metric"),
    ).toBe(true)
    expect(
      ObservabilityIssues.list({ module: "observability" }).some((issue) => issue.code === "PERF_TEST_STORE"),
    ).toBe(true)
    expect(ObservabilityStore.resourceSince(0).length).toBeGreaterThan(0)
    expect(new Set(ObservabilityStore.meta().map((row) => row.key))).toContain("schemaVersion")
  })

  test("ignores JSONL-only mirror files in indexed runtime query", async () => {
    const fs = await import("fs/promises")
    const path = await import("path")
    const traceDir = path.join(process.env.SYNERGY_TEST_HOME!, "state", "observability", "traces")
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(
      path.join(traceDir, "2026-01-01.jsonl"),
      JSON.stringify({ type: "jsonl.only", traceId: "trace_jsonl" }) + "\n",
    )

    expect(ObservabilityStore.queryEvents({ traceId: "trace_jsonl" })).toEqual([])
  })

  test("deduplicates implicit issue fingerprints across trace IDs", () => {
    ObservabilityIssues.raise({
      code: "PERF_TEST_DEDUPE",
      severity: "warning",
      module: "observability",
      title: "Dedupe issue",
      message: "Dedupe issue",
      traceId: "trace_1",
      callID: "call_1",
    })
    ObservabilityIssues.raise({
      code: "PERF_TEST_DEDUPE",
      severity: "warning",
      module: "observability",
      title: "Dedupe issue",
      message: "Dedupe issue",
      traceId: "trace_2",
      callID: "call_2",
    })

    const issues = ObservabilityIssues.list({ module: "observability" }).filter(
      (issue) => issue.code === "PERF_TEST_DEDUPE",
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.fingerprint).toBe("PERF_TEST_DEDUPE:observability")
    expect(issues[0]?.occurrenceCount).toBe(2)
    expect(issues[0]?.evidence.latestTraceId).toBe("trace_2")
    expect(issues[0]?.evidence.latestCallID).toBe("call_2")
  })

  test("queryMetrics newestFirst returns rows in descending time order without JS reversal", () => {
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
  })

  test("compact timer is created on open and cleared on close", () => {
    const conn = ObservabilityStore.open()
    expect(conn).toBeDefined()
    ObservabilityStore.close()
    const reopened = ObservabilityStore.open()
    expect(reopened).toBeDefined()
    ObservabilityStore.close()
  })

  test("checkpoints and truncates the WAL on graceful close", async () => {
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
  })

  test("queryIssues finds issues by evidence_json scopeID fallback", () => {
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
  })
  test("retain runs without errors and writes meta timestamp", () => {
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
  })
})

test("stats reports pending queue length and dropped job count", () => {
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
})

test("queues retention after open and runs it on flush", () => {
  ObservabilityStore.flush()
  const meta = ObservabilityStore.meta()
  expect(meta.some((row) => row.key === "lastRetentionRunAt")).toBe(true)
  expect(Number(meta.find((row) => row.key === "lastRetentionRunAt")!.value)).toBeGreaterThan(0)
})

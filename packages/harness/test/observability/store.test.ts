import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, statSync } from "fs"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityResources } from "../../src/observability/resources"
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

  test("deduplicates implicit issue fingerprints across trace IDs", () =>
    runtime.run(() => {
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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { ObservabilityClock } from "../../src/observability/clock"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityContext } from "../../src/observability/context"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityTelemetryClient } from "../../src/observability/telemetry-client"
import { TelemetryProtocol } from "../../src/observability/telemetry-protocol"
import { testRuntime } from "../support/runtime"
let runtime: Awaited<ReturnType<typeof testRuntime>>

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(intervalMs)
  }
  expect(predicate()).toBe(true)
}

describe("ObservabilityStore worker mode", () => {
  beforeEach(async () => {
    runtime = await testRuntime({ env: { SYNERGY_OBSERVABILITY_INLINE: undefined } })
    await runtime.run(async () => {
      ObservabilityConfig.refresh()
      ObservabilityStore.markRuntimeReady()
      await ObservabilityStore.close()
    })
  })

  afterEach(() => runtime.close())

  test("records metrics through the worker subprocess and reads them via the readonly connection", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      // Wait for the worker's ready handshake, not just the readonly connection:
      // the sqlite file appears as soon as the worker opens it, but batches only
      // flow once the worker has processed the start message.
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === true, 15_000)
      expect(ObservabilityStore.stats().available).toBe(true)

      ObservabilityMetrics.record({
        name: "worker.mode.metric",
        value: 42,
        unit: "count",
        module: "observability",
      })
      ObservabilityStore.flush()
      await ObservabilityTelemetryClient.flushAndWait(5000)

      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["worker.mode.metric"] })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe(42)
      expect(rows[0]?.name).toBe("worker.mode.metric")
    }))

  test("stats reports available while the worker runs", () =>
    runtime.run(async () => {
      expect(ObservabilityTelemetryClient.stats().workerReady).toBe(false)
      ObservabilityStore.open()
      await waitFor(() => ObservabilityStore.stats().available === true, 15_000)
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === true, 15_000)
      expect(ObservabilityStore.stats().pending).toBeGreaterThanOrEqual(0)
      expect(ObservabilityStore.stats().checkpointIntervalMs).toBe(60_000)
    }))

  test("uses the existing worker batch window for exact condition deltas and typed recovery", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      using enqueues = spyOn(ObservabilityTelemetryClient, "enqueue")
      const input = {
        owner: "control-plane" as const,
        code: "PERF_TEST_WORKER_CONDITION",
        module: "process" as const,
        title: "Worker condition",
        severity: "warning" as const,
        state: "active" as const,
        observedValue: 120,
        thresholdValue: 100,
        unit: "bytes" as const,
      }
      for (let index = 0; index < 1000; index++)
        ObservabilityIssues.observeCondition({ ...input, observedValue: 120 + index })
      using observer = new Database(ObservabilityStore.pathName(), { readonly: true })
      await waitFor(
        () => observer.query("SELECT issue_id FROM obs_issues WHERE code = ?").get(input.code) !== null,
        5000,
      )
      const [first] = ObservabilityIssues.list({ module: "process" })
      expect(first).toMatchObject({
        occurrenceCount: 1000,
        evidence: { firstObservedValue: 120, observedValue: 1119, peakObservedValue: 1119 },
      })
      expect(enqueues.mock.calls.filter(([row]) => row.kind === "issue")).toHaveLength(1)
      ObservabilityIssues.observeCondition({ ...input, observedValue: 130 })
      ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 20 })
      ObservabilityIssues.observeCondition({ ...input, observedValue: 140 })
      ObservabilityStore.queryIssues()
      await ObservabilityTelemetryClient.flushAndWait()
      expect(ObservabilityIssues.list({ status: "resolved", module: "process" })).toMatchObject([
        { issueId: first.issueId, occurrenceCount: 1001 },
      ])
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([
        { occurrenceCount: 1, evidence: { firstObservedValue: 140 } },
      ])
      ObservabilityIssues.observeCondition({ ...input, observedValue: 150 })
      await ObservabilityStore.stop()
      using reader = new Database(ObservabilityStore.pathName(), { readonly: true })
      expect(
        reader.query("SELECT occurrence_count FROM obs_issues WHERE status = 'open' AND code = ?").get(input.code),
      ).toEqual({ occurrence_count: 2 })
    }))

  test("disabling drains accepted conditions and young gauges through the real worker before it exits", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      const input = {
        owner: "control-plane" as const,
        code: "PERF_TEST_WORKER_DISABLE",
        module: "process" as const,
        title: "Worker disable",
        severity: "warning" as const,
        state: "active" as const,
        observedValue: 120,
        thresholdValue: 100,
        unit: "bytes" as const,
      }
      for (let index = 0; index < 100; index++) {
        ObservabilityIssues.observeCondition(input)
        ObservabilityMetrics.record({
          name: "storage.queue.depth",
          value: index,
          unit: "count",
          module: "storage",
          labels: { queue: "worker-disable-drain" },
        })
      }
      const dropped = ObservabilityStore.stats().dropped
      ObservabilityConfig.refresh({ observability: { performance: { enabled: false } } })
      await ObservabilityStore.reconfigure()
      expect(ObservabilityTelemetryClient.stats().workerReady).toBe(false)
      const version = ObservabilityStore.dataVersion()
      ObservabilityIssues.observeCondition(input)
      expect(ObservabilityStore.dataVersion()).toBe(version)
      expect(ObservabilityStore.stats().dropped).toBe(dropped)
      using reader = new Database(ObservabilityStore.pathName(), { readonly: true })
      expect(reader.query("SELECT occurrence_count FROM obs_issues WHERE code = ?").get(input.code)).toEqual({
        occurrence_count: 100,
      })
      expect(
        reader
          .query("SELECT name, value FROM obs_metrics WHERE json_extract(labels_json, '$.queue') = ? ORDER BY name")
          .all("worker-disable-drain"),
      ).toEqual([
        { name: "storage.queue.depth", value: 99 },
        { name: "storage.queue.depth.peak", value: 99 },
      ])
    }))

  test("real worker recovery rollback preserves old evidence and reentry creates an independent episode", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      let now = Date.now()
      using clock = spyOn(ObservabilityClock, "now").mockImplementation(() => now)
      const input = {
        owner: "control-plane" as const,
        code: "PERF_WORKER_RECOVERY_ROLLBACK",
        module: "process" as const,
        title: "Worker recovery rollback",
        severity: "warning" as const,
        state: "active" as const,
        thresholdValue: 100,
        unit: "bytes" as const,
        scopeID: "worker-recovery-rollback",
      }
      for (const observedValue of [120, 240]) {
        ObservabilityIssues.observeCondition({ ...input, observedValue })
        now++
      }
      ObservabilityStore.flush()
      await ObservabilityTelemetryClient.flushAndWait()
      const [first] = ObservabilityIssues.list({ scopeID: input.scopeID })
      const beforeFault = ObservabilityTelemetryClient.stats()
      using control = new Database(ObservabilityStore.pathName())
      control.exec(
        "CREATE TRIGGER reject_worker_recovery BEFORE UPDATE OF status ON obs_issues WHEN NEW.status = 'resolved' BEGIN SELECT RAISE(ABORT, 'injected worker recovery rollback'); END",
      )
      try {
        for (const observedValue of [500, 300]) {
          ObservabilityIssues.observeCondition({ ...input, observedValue })
          now++
        }
        ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 20 })
        ObservabilityStore.flush()
        await ObservabilityTelemetryClient.flushAndWait()
        expect(ObservabilityTelemetryClient.stats()).toMatchObject({
          dropped: beforeFault.dropped + 3,
          uncertain: beforeFault.uncertain,
          pending: 0,
          unconfirmed: 0,
          restarts: beforeFault.restarts,
        })
        expect(ObservabilityTelemetryClient.stats().lastError).toContain("injected worker recovery rollback")
        expect(ObservabilityIssues.list({ scopeID: input.scopeID })).toEqual([first])
        expect(ObservabilityIssues.list({ scopeID: input.scopeID, status: "resolved" })).toEqual([])
      } finally {
        control.exec("DROP TRIGGER reject_worker_recovery")
      }
      now += 100
      const reenteredAt = now
      ObservabilityContext.withContext({ sessionID: "fresh-worker-episode", traceId: "fresh-worker-trace" }, () => {
        for (const observedValue of [130, 190, 140]) {
          ObservabilityIssues.observeCondition({ ...input, observedValue })
          now++
        }
      })
      ObservabilityStore.flush()
      await ObservabilityTelemetryClient.flushAndWait()
      const [next] = ObservabilityIssues.list({ scopeID: input.scopeID })
      expect(next.issueId).not.toBe(first.issueId)
      expect(next).toMatchObject({
        fingerprint: first.fingerprint,
        occurrenceCount: 3,
        firstSeenTime: reenteredAt,
        lastSeenTime: now - 1,
        sessionID: "fresh-worker-episode",
        traceId: "fresh-worker-trace",
        evidence: { firstObservedValue: 130, peakObservedValue: 190, observedValue: 140 },
      })
      const [suppressed] = ObservabilityIssues.list({ scopeID: input.scopeID, status: "suppressed" })
      expect(suppressed).toEqual({
        ...first,
        status: "suppressed",
        evidence: {
          ...first.evidence,
          suppressionReason: "condition_episode_superseded_without_persisted_recovery",
          supersededByIssueId: next.issueId,
        },
      })
      expect(suppressed.evidence.resolvedTime).toBeUndefined()
      expect(suppressed.evidence.recoveryObservedValue).toBeUndefined()
      expect(ObservabilityIssues.list({ scopeID: input.scopeID, status: "resolved" })).toEqual([])
      ObservabilityIssues.observeCondition({ ...input, observedValue: 160 })
      ObservabilityStore.flush()
      await ObservabilityTelemetryClient.flushAndWait()
      expect(ObservabilityIssues.list({ scopeID: input.scopeID })).toMatchObject([
        {
          issueId: next.issueId,
          occurrenceCount: 4,
          firstSeenTime: reenteredAt,
          evidence: { firstObservedValue: 130, peakObservedValue: 190, observedValue: 160 },
        },
      ])
      expect(ObservabilityTelemetryClient.stats().dropped).toBe(beforeFault.dropped + 3)
    }))

  test.each(["committed-before-confirmation-loss", "uncommitted"] as const)(
    "worker loss keeps the old uncertain delta separate from fresh pending observations: %s",
    (outcome) =>
      runtime.run(async () => {
        ObservabilityStore.open()
        await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
        const input = {
          owner: "control-plane" as const,
          code: "PERF_WORKER_UNCERTAIN_DELTA",
          module: "process" as const,
          title: "Worker uncertain delta",
          severity: "warning" as const,
          state: "active" as const,
          thresholdValue: 100,
          unit: "bytes" as const,
          scopeID: "worker-uncertain-delta",
        }
        ObservabilityMetrics.record({
          name: "storage.queue.depth",
          value: 1,
          unit: "count",
          module: "storage",
          labels: { queue: "worker-startup" },
        })
        for (const observedValue of [120, 180]) ObservabilityIssues.observeCondition({ ...input, observedValue })
        ObservabilityStore.flush(true)
        await ObservabilityTelemetryClient.flushAndWait()
        const [first] = ObservabilityIssues.list({ scopeID: input.scopeID })
        const beforeFault = ObservabilityTelemetryClient.stats()
        const oldWorker = ObservabilityTelemetryClient.workerProcess()!
        const parseMessage = TelemetryProtocol.parseWorkerToHost
        let loseConfirmations = true
        let confirmationLost = false
        using transport = spyOn(TelemetryProtocol, "parseWorkerToHost").mockImplementation((raw) => {
          const message = parseMessage(raw)
          if (loseConfirmations && (message?.type === "status" || message?.type === "ack")) {
            if (message.type === "status") confirmationLost = true
            return undefined
          }
          return message
        })
        using control = new Database(ObservabilityStore.pathName())
        let writeBlocked = false
        try {
          if (outcome === "uncommitted") {
            control.exec("BEGIN IMMEDIATE")
            writeBlocked = true
          }
          // Startup gauges must stay in the acknowledged prefix even if they mature during the fault.
          ObservabilityMetrics.flushAggregates(true)
          for (const observedValue of [200, 260, 500, 240, 230, 220, 210])
            ObservabilityIssues.observeCondition({ ...input, observedValue })
          ObservabilityStore.flush()
          expect(ObservabilityTelemetryClient.stats().unconfirmed).toBe(1)
          if (outcome === "committed-before-confirmation-loss") await waitFor(() => confirmationLost, 5000)
          expect(
            control.query("SELECT occurrence_count FROM obs_issues WHERE issue_id = ?").get(first.issueId),
          ).toEqual({
            occurrence_count: outcome === "committed-before-confirmation-loss" ? 9 : 2,
          })
          oldWorker.kill(9)
          await oldWorker.exited
        } finally {
          if (writeBlocked) control.exec("ROLLBACK")
        }
        await waitFor(() => ObservabilityTelemetryClient.stats().restarts > beforeFault.restarts, 15_000)
        loseConfirmations = false
        expect(ObservabilityTelemetryClient.stats()).toMatchObject({
          uncertain: beforeFault.uncertain + 7,
          dropped: beforeFault.dropped,
          unconfirmed: 0,
        })
        using enqueues = spyOn(ObservabilityTelemetryClient, "enqueue")
        ObservabilityContext.withContext(
          { sessionID: "fresh-worker-observations", traceId: "fresh-observation-trace" },
          () => {
            for (const observedValue of [130, 170, 140])
              ObservabilityIssues.observeCondition({ ...input, observedValue })
          },
        )
        ObservabilityStore.flush()
        const freshRows = enqueues.mock.calls.map(([row]) => row).filter((row) => row.kind === "issue")
        expect(freshRows).toMatchObject([{ row: { issueId: first.issueId, occurrenceCount: 3 } }])
        await ObservabilityTelemetryClient.flushAndWait()
        expect(ObservabilityTelemetryClient.workerProcess()).not.toBe(oldWorker)
        expect(ObservabilityIssues.list({ scopeID: input.scopeID })).toMatchObject([
          {
            issueId: first.issueId,
            firstSeenTime: first.firstSeenTime,
            occurrenceCount: outcome === "committed-before-confirmation-loss" ? 12 : 5,
            sessionID: "fresh-worker-observations",
            traceId: "fresh-observation-trace",
            evidence: { firstObservedValue: 120, peakObservedValue: 500, observedValue: 140 },
          },
        ])
        expect(ObservabilityIssues.list({ scopeID: input.scopeID, status: "suppressed" })).toEqual([])
        expect(ObservabilityTelemetryClient.stats()).toMatchObject({
          uncertain: beforeFault.uncertain + 7,
          dropped: beforeFault.dropped,
          pending: 0,
          unconfirmed: 0,
          restarts: beforeFault.restarts + 1,
        })
      }),
  )

  test("metric aggregation yields to the host and retains numeric bucket results", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      for (const value of [10, 20, 30])
        ObservabilityMetrics.record({ name: "reader.metric", value, unit: "ms", module: "observability" })
      await ObservabilityTelemetryClient.flushAndWait()
      const tick = new Promise<string>((resolve) => setTimeout(() => resolve("host"), 0))
      const query = Promise.resolve(
        ObservabilityStore.queryMetricBuckets({ since: 0, names: ["reader.metric"], bucketMs: Date.now() + 1 }),
      )
      expect(await Promise.race([query.then(() => "query"), tick])).toBe("host")
      expect(await query).toEqual([expect.objectContaining({ count: 3, sum: 60, p50: 20, p95: 30, errors: 0 })])
      await ObservabilityStore.close()
      ObservabilityStore.open()
      expect(await ObservabilityStore.queryMetricCounts({ since: 0, names: ["reader.metric"] })).toEqual([
        { name: "reader.metric", module: "observability", count: 3 },
      ])
    }))

  test("close drains the active metric read and rejects queued reads", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      const first = ObservabilityStore.queryMetricCounts({ since: 0 })
      const second = ObservabilityStore.queryMetricCounts({ since: 0 })
      const results = Promise.allSettled([first, second])
      await ObservabilityStore.close()
      expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected"])
      ObservabilityStore.open()
      expect(await ObservabilityStore.queryMetricCounts({ since: 0 })).toBeArray()
    }))

  test("a stopped store cannot reopen the metric reader", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.stop()
      await expect(ObservabilityStore.queryMetricCounts({ since: 0 })).rejects.toThrow("closed")
    }))

  test("close stops the worker", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.close()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === false, 10_000)
    }))
  test("re-enabling after close restarts the worker via reconfigure", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.close()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === false, 10_000)

      // Disable, then re-enable through the config path; reconfigure() must
      // start the worker again instead of buffering a control message forever.
      ObservabilityConfig.refresh({ observability: { enabled: true } })
      ObservabilityStore.reconfigure()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      expect(ObservabilityStore.stats().available).toBe(true)
    }))

  test("drops telemetry while observability is disabled", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      ObservabilityConfig.refresh({ observability: { enabled: false } })
      ObservabilityStore.insertMetric({
        metricId: "disabled_metric",
        time: Date.now(),
        name: "disabled.metric",
        value: 1,
        unit: "count",
        source: "backend",
        module: "observability",
        labels: {},
        sampleRate: 1,
      })
      expect(ObservabilityTelemetryClient.stats().pending).toBe(0)
    }))
})

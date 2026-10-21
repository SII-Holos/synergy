import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { ObservabilityClock } from "../../src/observability/clock"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityContext } from "../../src/observability/context"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityStore } from "../../src/observability/store"
import { clearObservabilityState, resetObservabilityState } from "./fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("ObservabilitySpans", () => {
  beforeEach(() => runtime.run(() => resetObservabilityState()))
  afterEach(() => runtime.run(() => clearObservabilityState()))

  test.each([
    ["session", "slowSessionTurnMs", "PERF_SESSION_SLOW_TURN"],
    ["llm", "slowLlmCallMs", "PERF_LLM_SLOW_CALL"],
    ["tool", "slowToolMs", "PERF_TOOL_SLOW_EXECUTION"],
  ] as const)("%s completion uses its configured threshold and captured attribution", (module, thresholdKey, code) =>
    runtime.run(() => {
      const threshold = 12_345
      ObservabilityConfig.refresh({ observability: { performance: { thresholds: { [thresholdKey]: threshold } } } })
      using duration = spyOn(ObservabilityClock, "durationMs")
      const identity = {
        scopeID: "scope_captured",
        sessionID: "ses_captured",
        messageID: "msg_captured",
        callID: "call_captured",
        rid: "request_captured",
        correlationId: "corr_captured",
      }
      for (const elapsed of [threshold - 1, threshold]) {
        const span = ObservabilityContext.withContext(identity, () =>
          ObservabilitySpans.start({ name: `${module}.execute`, module }),
        )!
        expect(span).toMatchObject(identity)
        duration.mockReturnValue(elapsed)
        ObservabilityContext.withContext(
          { scopeID: "scope_other", sessionID: "ses_other", messageID: "msg_other", callID: "call_other" },
          () => ObservabilitySpans.end(span),
        )
        const issues = ObservabilityIssues.list({ module })
        if (elapsed < threshold) {
          expect(issues).toEqual([])
          continue
        }
        expect(issues).toHaveLength(1)
        expect(issues[0]).toMatchObject({
          ...identity,
          code,
          traceId: span.traceId,
          spanId: span.spanId,
          evidence: { observedValue: threshold, unit: "ms" },
        })
      }
    }),
  )

  test("global completion does not acquire attribution from an unrelated ambient context", () =>
    runtime.run(() => {
      using duration = spyOn(ObservabilityClock, "durationMs").mockReturnValue(30_000)
      const span = ObservabilitySpans.start({ name: "tool.execute", module: "tool" })!
      ObservabilityContext.withContext({ scopeID: "scope_other", sessionID: "ses_other", callID: "call_other" }, () =>
        ObservabilitySpans.end(span),
      )
      const [issue] = ObservabilityIssues.list({ module: "tool" })
      expect(issue).toBeDefined()
      expect([issue.scopeID, issue.sessionID, issue.callID]).toEqual([undefined, undefined, undefined])
    }))

  test("persists running span before completion and removes it from inflight on end", () =>
    runtime.run(() => {
      const span = ObservabilitySpans.start({
        name: "tool.execute",
        module: "tool",
        sessionID: "ses_1",
        callID: "call_1",
        attributes: { command: "bun test", password: "secret" },
      })!
      ObservabilityStore.flush()

      const running = ObservabilityStore.queryInflight({ sessionID: "ses_1" })
      expect(running).toHaveLength(1)
      expect(running[0].status).toBe("running")
      expect(JSON.parse(running[0].attributes_json).password).toBe("[redacted]")

      ObservabilitySpans.heartbeat(span, { phase: "running" })
      ObservabilityStore.flush()
      const heartbeat = ObservabilityStore.queryInflight({ sessionID: "ses_1" })[0]
      expect(heartbeat.heartbeat_count).toBeGreaterThanOrEqual(1)

      ObservabilitySpans.end(span)
      ObservabilityStore.flush()
      expect(ObservabilityStore.queryInflight({ sessionID: "ses_1" })).toEqual([])
      const completed = ObservabilityStore.querySpans({ traceId: span.traceId })[0]
      expect(completed.status).toBe("ok")
      expect(completed.end_time).toBeDefined()
    }))

  test("marks stale running spans without hiding them", () =>
    runtime.run(() => {
      const span = ObservabilitySpans.start({ name: "llm.stream", module: "llm", sessionID: "ses_2" })!
      ObservabilityStore.flush()

      const inflight = ObservabilityStore.queryInflight({ sessionID: "ses_2", staleMs: 0 })
      expect(inflight).toHaveLength(1)
      expect(inflight[0].span_id).toBe(span.spanId)
      expect(inflight[0].stale).toBe(true)
    }))

  test("heartbeats and diagnoses do not manufacture progress or reopen a settled span", () =>
    runtime.run(() => {
      using clock = spyOn(ObservabilityClock, "now").mockReturnValue(1000)
      const span = ObservabilitySpans.start({ name: "tool.execute", module: "tool" })!
      clock.mockReturnValue(2000)
      ObservabilitySpans.activity(span)
      clock.mockReturnValue(40_000)
      ObservabilitySpans.heartbeat(span)
      ObservabilitySpans.markStalled(span)
      const running = ObservabilityStore.querySpans({ traceId: span.traceId })[0]
      expect(running.last_activity_time).toBe(2000)
      expect(running.heartbeat_time).toBe(40_000)
      expect(running.stalled).toBe(1)
      ObservabilitySpans.end(span)
      clock.mockReturnValue(50_000)
      ObservabilitySpans.activity(span)
      ObservabilitySpans.heartbeat(span)
      ObservabilitySpans.markStalled(span)
      expect(ObservabilityStore.queryInflight().filter((row) => row.span_id === span.spanId)).toEqual([])
      expect(ObservabilityStore.querySpans({ traceId: span.traceId })[0].status).toBe("ok")
    }))

  test("filters inflight spans by last activity instead of start time", () =>
    runtime.run(() => {
      const inactive = ObservabilitySpans.start({ name: "tool.inactive", module: "tool" })!
      const active = ObservabilitySpans.start({ name: "tool.active", module: "tool" })!
      ObservabilityStore.flush()
      const now = Date.now()
      const db = ObservabilityStore.initializeForMigration()
      db.query("UPDATE obs_spans SET start_time = ?, last_activity_time = ? WHERE span_id = ?").run(
        now - 30 * 60_000,
        now - 20 * 60_000,
        inactive.spanId,
      )
      db.query("UPDATE obs_spans SET start_time = ?, last_activity_time = ? WHERE span_id = ?").run(
        now - 30 * 60_000,
        now - 60_000,
        active.spanId,
      )

      const inflight = ObservabilityStore.queryInflight({ activeSince: now - 15 * 60_000 })

      expect(inflight.map((row) => row.span_id)).toEqual([active.spanId])
    }))

  test("reconciles persisted running spans as interrupted", () =>
    runtime.run(() => {
      const span = ObservabilitySpans.start({ name: "llm.stream", module: "llm" })!
      ObservabilityStore.flush()
      const db = ObservabilityStore.initializeForMigration()
      db.query("UPDATE obs_spans SET last_activity_time = ? WHERE span_id = ?").run(span.startTime + 1234, span.spanId)

      expect(ObservabilityStore.interruptRunningSpans({ reason: "previous_runtime_ended" })).toBe(1)
      expect(ObservabilityStore.queryInflight()).toEqual([])
      expect(ObservabilityStore.querySpans({ traceId: span.traceId })[0]).toMatchObject({
        status: "interrupted",
        end_time: span.startTime + 1234,
        duration_ms: 1234,
        error_code: "PROCESS_INTERRUPTED",
      })
    }))
})

afterRuntimeTests(() => runtime.close())

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityStore } from "../../src/observability/store"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("ObservabilitySpans", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => cleanupObservabilityHomes())

  test("persists running span before completion and removes it from inflight on end", () => {
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
  })

  test("marks stale running spans without hiding them", () => {
    const span = ObservabilitySpans.start({ name: "llm.stream", module: "llm", sessionID: "ses_2" })!
    ObservabilityStore.flush()

    const inflight = ObservabilityStore.queryInflight({ sessionID: "ses_2", staleMs: 0 })
    expect(inflight).toHaveLength(1)
    expect(inflight[0].span_id).toBe(span.spanId)
    expect(inflight[0].stale).toBe(true)
  })

  test("filters inflight spans by last activity instead of start time", () => {
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
  })

  test("reconciles persisted running spans as interrupted", () => {
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
  })
})

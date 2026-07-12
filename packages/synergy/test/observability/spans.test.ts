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
})

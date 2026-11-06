import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { ObservabilityContext } from "@ericsanchezok/synergy-harness/observability/context"
import { ObservabilityIssues } from "@ericsanchezok/synergy-harness/observability/issues"
import { ObservabilityLiveEvents } from "@ericsanchezok/synergy-harness/observability/live-events"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerConfig } from "../../src/config-schema"
import { PerformanceRoute } from "../../src/performance/routes/performance-route"

let runtime: Awaited<ReturnType<typeof migrationFixture>>
beforeEach(async () => {
  runtime = await migrationFixture({
    register() {
      registerConfig()
      ObservabilityMetrics.register()
    },
  })
})
afterEach(() => runtime.close())

async function connect(query = "") {
  const subscribed = Promise.withResolvers<void>()
  const subscribe = ObservabilityLiveEvents.subscribe
  const subscription = spyOn(ObservabilityLiveEvents, "subscribe").mockImplementation((listener) => {
    const unsubscribe = subscribe(listener)
    subscribed.resolve()
    return unsubscribe
  })
  const response = await PerformanceRoute().request(`/performance/events${query}`)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  async function read() {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Performance stream ended before the next event")
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    const end = buffer.indexOf("\n\n")
    const lines = buffer.slice(0, end).split("\n")
    buffer = buffer.slice(end + 2)
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(
        lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n"),
      ) as unknown,
    }
  }
  async function next() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for a performance event")), 2000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    expect((await next()).event).toBe("performance.summary.updated")
    await subscribed.promise
  } catch (error) {
    await reader.cancel()
    throw error
  } finally {
    subscription.mockRestore()
  }
  return { next, close: () => reader.cancel() }
}

function observe(scopeID: string, sessionID: string, state: "active" | "normal", code = "PERF_TEST_CONDITION") {
  ObservabilityContext.withContext({ scopeID, sessionID }, () =>
    ObservabilityIssues.observeCondition({
      owner: "control-plane",
      code,
      module: "process",
      title: "Test process pressure",
      severity: "warning",
      state,
      observedValue: state === "active" ? 200 : 20,
      thresholdValue: 100,
      unit: "bytes",
    }),
  )
}

describe.serial("performance live events", () => {
  test("delivers condition recovery and preserves Scope and Session filtering", () =>
    runtime.run(async () => {
      const stream = await connect("?scopeID=scope_selected&sessionID=session_selected")
      try {
        observe("scope_other", "session_selected", "active")
        observe("scope_other", "session_selected", "normal")
        observe("scope_selected", "session_other", "active", "PERF_TEST_OTHER_SESSION")
        observe("scope_selected", "session_other", "normal", "PERF_TEST_OTHER_SESSION")
        observe("scope_selected", "session_selected", "active")
        observe("scope_selected", "session_selected", "normal")
        observe("scope_selected", "session_selected", "active", "PERF_TEST_BARRIER")

        const raised = await stream.next()
        expect(raised).toMatchObject({
          event: "performance.issue.raised",
          data: {
            code: "PERF_TEST_CONDITION",
            status: "open",
            scopeID: "scope_selected",
            sessionID: "session_selected",
          },
        })
        const resolved = await stream.next()
        expect(resolved).toMatchObject({
          event: "performance.issue.resolved",
          data: {
            code: "PERF_TEST_CONDITION",
            status: "resolved",
            scopeID: "scope_selected",
            sessionID: "session_selected",
            occurrenceCount: 1,
            evidence: { recoveryObservedValue: 20, recoveryThresholdValue: 100 },
          },
        })
        expect((await stream.next()).data).toMatchObject({ code: "PERF_TEST_BARRIER" })
      } finally {
        await stream.close()
      }
    }))

  test("cancelling one subscriber leaves the healthy subscriber receiving subsequent episodes", () =>
    runtime.run(async () => {
      const closed = await connect()
      const healthy = await connect()
      try {
        await closed.close()
        observe("scope_selected", "session_selected", "active")
        observe("scope_selected", "session_selected", "normal")
        observe("scope_selected", "session_selected", "active", "PERF_TEST_BARRIER")
        expect((await healthy.next()).event).toBe("performance.issue.raised")
        expect((await healthy.next()).event).toBe("performance.issue.resolved")
        expect((await healthy.next()).data).toMatchObject({ code: "PERF_TEST_BARRIER" })
      } finally {
        await Promise.all([closed.close(), healthy.close()])
      }
    }))
})

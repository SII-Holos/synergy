import { describe, expect, test } from "bun:test"
import { runtimeSupportItems } from "./runtime-support"
import type { PerformanceSummary } from "./types"

function summary(runtime: PerformanceSummary["runtime"]): PerformanceSummary {
  return {
    generatedAt: new Date(0).toISOString(),
    windowMs: 900_000,
    health: { status: "healthy", score: 100, openIssueCount: 0, criticalIssueCount: 0 },
    backend: { requestCount: 0, errorRate: 0, activeSessions: 0, pendingSessions: 0 },
    resources: {},
    sessions: { turnCount: 0, llmCallCount: 0, toolCallCount: 0 },
    frontend: { longTaskCount: 0 },
    runtime,
    top: {
      slowRoutes: [],
      slowSessions: [],
      slowTools: [],
      slowProviders: [],
      slowStorage: [],
      slowLibrary: [],
      slowFrontend: [],
    },
    issues: [],
  }
}

describe("performance dashboard runtime support", () => {
  test("surfaces diagnostics-derived runtime health fields", () => {
    const items = runtimeSupportItems(
      summary({
        alive: true,
        healthy: true,
        pid: 42,
        mode: "server",
        traceFiles: 3,
        recentErrors: 0,
        pendingSessions: 2,
      }),
    )
    expect(items).toContainEqual({ label: "Trace files", value: "3 files", tone: "default" })
    expect(items).toContainEqual({ label: "Recent errors", value: "0", tone: "default" })
    expect(items).toContainEqual({ label: "Pending sessions", value: "2", tone: "warning" })
    expect(items[0].value).toContain("Alive")
    expect(items[0].value).toContain("pid 42")
    expect(items[0].tone).toBe("success")
  })

  test("marks unhealthy runtime support state as warning", () => {
    const items = runtimeSupportItems(
      summary({ alive: false, healthy: false, traceFiles: 0, recentErrors: 5, pendingSessions: 0 }),
    )
    expect(items[0].tone).toBe("warning")
    expect(items[0].value).toContain("Not running")
    expect(items[2]).toEqual({ label: "Recent errors", value: "5", tone: "warning" })
  })
})

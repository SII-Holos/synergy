import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityStore } from "../../src/observability/store"
import { Diagnostics } from "../../src/observability/diagnostics"
import { ProcessRegistry } from "../../src/process/registry"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("Diagnostics", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => {
    ProcessRegistry.reset()
    cleanupObservabilityHomes()
  })

  test("summarizes indexed errors, issues, resources, and inflight spans", async () => {
    await fs.mkdir(path.join(process.env.SYNERGY_TEST_HOME!, "state", "observability", "traces"), { recursive: true })
    await fs.writeFile(
      path.join(process.env.SYNERGY_TEST_HOME!, "state", "observability", "traces", "jsonl-only.jsonl"),
      JSON.stringify({ type: "jsonl.only.error", level: "error", traceId: "trace_jsonl" }) + "\n",
    )

    await ObservabilityEvents.emit("session.turn.error", {
      traceId: "trace_indexed",
      sessionID: "ses_diag",
      level: "error",
      data: { token: "secret-token" },
    })
    ObservabilityIssues.raise({
      code: "PERF_DIAGNOSTICS_TEST",
      severity: "warning",
      module: "session",
      title: "Diagnostics test issue",
      message: "Diagnostics test issue",
      sessionID: "ses_diag",
    })
    const span = ObservabilitySpans.start({ name: "tool.execute", module: "tool", sessionID: "ses_diag" })!
    ObservabilityResources.snapshot({ role: "server" })
    ObservabilityStore.flush()

    const summary = await Diagnostics.summary()
    expect(summary.traces.recentErrors.some((event) => event.traceId === "trace_indexed")).toBe(true)
    expect(summary.traces.recentErrors.every((event) => event.traceId !== "trace_jsonl")).toBe(true)
    expect(JSON.stringify(summary.traces.recentErrors)).not.toContain("secret-token")
    expect(summary.issues.some((issue) => issue.code === "PERF_DIAGNOSTICS_TEST")).toBe(true)
    expect(summary.inflight.some((item) => item.spanId === span.spanId)).toBe(true)
    expect(summary.resources.latest?.process.role).toBe("server")
    expect(summary.resources.pressure.observabilityStoreAvailable).toBe(true)
    expect(summary.resources.pressure.observabilityDroppedWrites).toBeGreaterThanOrEqual(0)
  })

  test("package contains redacted indexed telemetry without JSONL-only events", async () => {
    await ObservabilityEvents.emit("tool.error", {
      traceId: "trace_pkg",
      sessionID: "ses_pkg",
      level: "error",
      data: { password: "super-secret", message: "failed" },
    })
    ObservabilityStore.flush()

    const output = path.join(process.env.SYNERGY_TEST_HOME!, "diagnostics.tar.gz")
    const result = await Diagnostics.createPackage({ sessionID: "ses_pkg", output })
    expect(result.output).toBe(output)
    expect(result.summary.traces.recentErrors.some((event) => event.traceId === "trace_pkg")).toBe(true)

    const listing = Bun.spawnSync(["tar", "-tzf", output])
    expect(listing.exitCode).toBe(0)
    const files = listing.stdout.toString()
    expect(files).toContain("./summary.json")
    expect(files).toContain("./observability/events.jsonl")

    const extract = Bun.spawnSync(["tar", "-xOzf", output, "./observability/events.jsonl"])
    expect(extract.exitCode).toBe(0)
    const events = extract.stdout.toString()
    expect(events).toContain("trace_pkg")
    expect(events).not.toContain("super-secret")
  })

  test("summarizes process diagnostics without raw command or output tails", async () => {
    const proc = ProcessRegistry.create({
      command: "curl -H 'X-Test-Header: sk-test-placeholder' https://example.test",
      description: "secret command",
      cwd: "/tmp/private-workspace",
    })
    ProcessRegistry.appendOutput(proc, "raw output token=secret-from-tail")

    const summary = await Diagnostics.summary()
    const serialized = JSON.stringify(summary.processes)
    expect(serialized).toContain('"family":"curl"')
    expect(serialized).toContain("tailOmitted")
    expect(serialized).not.toContain("sk-live-secret")
    expect(serialized).not.toContain("secret-from-tail")
    expect(serialized).not.toContain("/tmp/private-workspace")
  })
})

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
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

  test("createPackage bypasses the pending-session cache for a fresh snapshot", async () => {
    const home = process.env.SYNERGY_TEST_HOME!
    const sessionsDir = path.join(home, ".synergy", "data", "sessions", "scope:home", "ses_cached")
    await fs.mkdir(sessionsDir, { recursive: true })
    const infoPath = path.join(sessionsDir, "info.json")
    await fs.writeFile(infoPath, JSON.stringify({ id: "ses_cached", pendingReply: true, time: { updated: 1 } }))

    // First summary populates the cache.
    const first = await Diagnostics.summary()
    expect(first.sessions.pendingReply.some((item) => item.sessionID === "ses_cached")).toBe(true)

    // A subsequent summary within the TTL reuses the cached list.
    const cached = await Diagnostics.summary()
    expect(cached.sessions.pendingReply.some((item) => item.sessionID === "ses_cached")).toBe(true)

    // The session finishes; createPackage must see the fresh state even though
    // the 15s cache would still hold the stale pending entry.
    await fs.writeFile(infoPath, JSON.stringify({ id: "ses_cached", pendingReply: false, time: { updated: 2 } }))
    const output = path.join(home, "fresh-diagnostics.tar.gz")
    const result = await Diagnostics.createPackage({ output })
    expect(result.summary.sessions.pendingReply.some((item) => item.sessionID === "ses_cached")).toBe(false)
  })

  test("pending-session scan survives a transient EPERM on info.json reads", async () => {
    const home = process.env.SYNERGY_TEST_HOME!
    const sessionsDir = path.join(home, ".synergy", "data", "sessions", "scope:home", "ses_transient")
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionsDir, "info.json"),
      JSON.stringify({ id: "ses_transient", pendingReply: true, time: { updated: 1 } }),
    )

    const realReadFile: typeof fs.readFile = fs.readFile.bind(fs)
    let calls = 0
    const impl = (async (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string" && target.endsWith("info.json")) {
        calls += 1
        if (calls === 1) throw Object.assign(new Error("injected EPERM"), { code: "EPERM" })
      }
      return realReadFile(target as Parameters<typeof realReadFile>[0], ...(rest as []))
    }) as unknown as typeof fs.readFile
    using _read = spyOn(fs, "readFile").mockImplementation(impl)

    const summary = await Diagnostics.summary({ freshPendingSessions: true })
    expect(summary.sessions.pendingReply.some((item) => item.sessionID === "ses_transient")).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(2)
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

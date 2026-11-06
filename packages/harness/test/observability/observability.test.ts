import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ObservabilityEvents } from "../../src/observability/events"
import { ObservabilityStore } from "../../src/observability/store"

import { testRuntime } from "../support/runtime"
import { resetObservabilityState, clearObservabilityState } from "./fixture"
const runtime = await testRuntime()
const home = runtime.host.home

describe("observability", () => {
  beforeEach(() => runtime.run(resetObservabilityState))
  afterEach(() => runtime.run(clearObservabilityState))

  test("archives dev log before reopening it", () =>
    runtime.run(async () => {
      const { Log } = await import("../../src/util/log")
      const devFile = Log.devFile()
      await fs.mkdir(path.dirname(devFile), { recursive: true })
      await fs.writeFile(devFile, "old dev log\n", "utf8")

      await Log.init({ print: false, dev: true })
      Log.flush()

      const archives = await Log.listDevArchives()
      expect(archives.length).toBe(1)
      expect(await fs.readFile(archives[0], "utf8")).toBe("old dev log\n")
      expect(await fs.readFile(devFile, "utf8")).not.toContain("old dev log")
    }))

  test("writes sanitized queryable trace events", () =>
    runtime.run(async () => {
      const { Observability } = await import("../../src/observability")
      await fs.rm(Observability.dir(), { recursive: true, force: true })

      await Observability.emit("tool.start", {
        traceId: "trace-test",
        sessionID: "ses-test",
        callID: "call-test",
        tool: "bash",
        data: {
          token: "plain-secret",
          output: "Bearer abc.def",
        },
      })

      const events = await Observability.query({ traceId: "trace-test", sessionID: "ses-test", callID: "call-test" })
      expect(events.length).toBe(1)
      expect(events[0].data?.token).toBe("[redacted]")
      expect(JSON.stringify(events[0].data)).not.toContain("abc.def")
    }))

  test("redacts cwd in emitted events", () =>
    runtime.run(async () => {
      await ObservabilityEvents.emit("test.cwd", {
        cwd: "/Users/someuser/very/private/project",
        module: "observability",
      })
      ObservabilityStore.flush()
      const events = ObservabilityStore.queryEvents({ type: "test.cwd" })
      expect(events).toHaveLength(1)
      expect(events[0].cwd).toBeDefined()
      expect(events[0].cwd).not.toBeNull()
      expect(events[0].cwd).not.toContain("/Users/someuser")
      expect(events[0].cwd!.length).toBeLessThanOrEqual(128)
    }))

  test("releases server process lock explicitly", () =>
    runtime.run(async () => {
      const { ServerProcessLock } = await import("../../src/util/server-process-lock")
      await fs.rm(ServerProcessLock.path(), { force: true })

      const acquired = await ServerProcessLock.acquire()
      expect((await ServerProcessLock.read())?.pid).toBe(process.pid)

      await acquired.release()
      expect(await ServerProcessLock.read()).toBeUndefined()
    }))

  test("creates a local diagnostics package", () =>
    runtime.run(async () => {
      const { Observability } = await import("../../src/observability")
      const { Diagnostics } = await import("../../src/observability/diagnostics")
      await Observability.emit("session.turn.error", {
        sessionID: "ses-diagnostics",
        level: "error",
        data: {
          password: "super-secret",
        },
      })

      const output = path.join(home, "diagnostics.tar.gz")
      const result = await Diagnostics.createPackage({ output })
      const stat = await fs.stat(result.output)
      expect(stat.isFile()).toBe(true)
      expect(stat.size).toBeGreaterThan(0)
      expect(result.summary.traces.recentErrors.length).toBeGreaterThanOrEqual(1)
    }))
})

afterAll(() => runtime.close())

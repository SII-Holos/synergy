import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

// A terminally failed store cannot be repaired in place, so the Runtime must not
// keep serving HTTP over it. `Storage.onUnavailable` carries that judgement and
// `registerShutdown` escalates it into the same graceful shutdown used for
// SIGTERM, exiting non-zero so a supervisor (systemd Restart=on-failure, launchd
// KeepAlive, the Desktop manager) restarts the process. Because the escalation
// ends in `process.exit`, it is asserted out of process: a same-process test
// could only observe it by stubbing the behavior under test. The child reports
// readiness through a marker file first, so a startup failure cannot be mistaken
// for a successful escalation.
//
// The child observes escalation through its own subscription rather than
// inferring it from the exit status alone. That distinction matters because the
// exit status is produced by `gracefulShutdown` after `handle.close()` and
// `Log.flush()` return, and under a loaded coverage shard those can outlast the
// parent's patience — which made earlier versions of this test report a missing
// escalation when escalation had in fact happened. The subscription records the
// event itself, so the assertion names the behaviour under test.
//
// The child deliberately has no deadline of its own: `run()` never settles, and
// parking forever leaves the escalation and the parent's timeout as the only two
// ways it can stop.
const STARTUP_DEADLINE_MS = 120_000
const PARENT_TIMEOUT_MS = 240_000

test(
  "a terminally failed store escalates once into a non-zero runtime exit",
  async () => {
    // The child boots a second full runtime, so it gets its own home (reusing the
    // test home would collide with the store this process already installed) and
    // an explicit, hermetic environment. Inheriting this process's environment
    // makes the child's startup depend on whatever the harness happens to export,
    // which fails under the coverage runner.
    const isolated = await createIsolatedTestEnv()
    const root = await mkdtemp(path.join(os.tmpdir(), "storage-escalation-runtime-"))
    const readyMarker = path.join(root, "ready")
    const escalatedMarker = path.join(root, "escalated")
    const script = String.raw`
      import { writeFile } from "node:fs/promises"
      import path from "node:path"
      const { Log } = await import("@ericsanchezok/synergy-harness/util/log")
      Log.init({ print: false })
      const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
      const { getRuntimeEndpoint } = await import("@ericsanchezok/synergy-harness/util/runtime-endpoint")
      const { run } = await import("./src/server/runtime")
      let started = false
      void run({
        interactive: false,
        printBanner: false,
        printChannelStatus: false,
        network: { hostname: "127.0.0.1", port: 0 },
      }).catch((error) => {
        // run() is long-lived. Killing the store is the condition under test, and
        // this rejection is the same event that drives the escalation, which
        // still owes its graceful shutdown — so publishing this catch's code here
        // would report the wrong exit status. Only a rejection before the runtime
        // ever served is a real startup failure.
        if (started) return
        console.error("runtime startup failed", error)
        process.exit(2)
      })

      const deadline = Date.now() + ${STARTUP_DEADLINE_MS}
      while (Date.now() < deadline) {
        try {
          const response = await fetch(getRuntimeEndpoint().url + "/global/health")
          if (response.ok) { started = true; break }
        } catch {}
        await Bun.sleep(100)
      }
      if (!started) {
        console.error("runtime never became healthy")
        process.exit(3)
      }
      await writeFile(process.env.SYNERGY_ESCALATION_READY, "")
      // Record the escalation where it happens. This is an independent
      // subscription beside the Runtime's own, so it proves the event reached a
      // listener without asserting anything about how long the graceful close
      // that follows it takes.
      Storage.onUnavailable(() => void writeFile(process.env.SYNERGY_ESCALATION_ESCALATED, ""))
      Storage.current().store.driver.worker.kill()
      // Park forever. The escalation owns the only exit that may happen; if it
      // never arrives, the parent's timeout reports the missing escalation
      // instead of this statement manufacturing an outcome.
      await new Promise(() => {})
    `

    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SYNERGY_TEST_HOME: isolated.env.SYNERGY_TEST_HOME,
        SYNERGY_TEST_ROOT: isolated.env.SYNERGY_TEST_ROOT,
        SYNERGY_ESCALATION_READY: readyMarker,
        SYNERGY_ESCALATION_ESCALATED: escalatedMarker,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    // Drain both streams for the child's whole lifetime. Startup and shutdown
    // write more than one pipe buffer, so an undrained pipe blocks the child and
    // it never reaches escalation.
    const stderrText = new Response(child.stderr).text()
    const stdoutText = new Response(child.stdout).text()

    try {
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(PARENT_TIMEOUT_MS).then(() => {
          child.kill()
          return -1
        }),
      ])
      const stderr = await stderrText
      await stdoutText

      // Each assertion separates a different defect: readiness distinguishes
      // "never reached the listener" from "reached it and did not escalate",
      // the escalation marker names the behaviour, and the exit status covers
      // the supervisor contract the escalation exists to satisfy.
      expect(
        await readFile(readyMarker, "utf8").catch(() => undefined),
        `runtime never became healthy: ${stderr}`,
      ).toBe("")
      expect(
        await readFile(escalatedMarker, "utf8").catch(() => undefined),
        `storage unavailability never reached a listener: ${stderr}`,
      ).toBe("")
      expect(exitCode, `runtime kept running over a dead store: ${stderr}`).toBe(1)
    } finally {
      child.kill()
      await Promise.all([rm(root, { recursive: true, force: true }), isolated.dispose()])
    }
  },
  PARENT_TIMEOUT_MS + 60_000,
)

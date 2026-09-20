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
// ends in a process exit, it has to be observed from outside the process, and
// the child hands over both halves of the contract:
//
//   * the `escalated` marker, written only when a 503 on the health route shows
//     that `gracefulShutdown` closed admission — the first act of the escalation;
//   * the `exit` marker, written from the child's own `process.on("exit")`
//     handler, which records the code the escalation passed to `process.exit`.
//
// The exit marker is what makes the teardown tail assertable. `process.exit`
// runs its handlers and then terminates, so the marker is the last thing the
// process writes — reached either by a drain that completed, or by the
// `handle.shutdownTimeoutMs` watchdog that bounds a drain which cannot complete.
// Either way this is not a wait on the drain itself, which on a loaded coverage
// shard is not a duration this test can honestly bound. The parent additionally
// confirms that the operating system observed the same status, which is a short
// wait because the process is already at the end of its life once the marker
// exists.
//
// The one-shot/terminal semantics of the listener are covered deterministically
// by `packages/harness/test/storage/storage-unavailable-escalation.test.ts`.
const STARTUP_DEADLINE_MS = 120_000
const ESCALATION_DEADLINE_MS = 120_000
const EXIT_DEADLINE_MS = 60_000
const EXIT_CONFIRM_MS = 60_000

async function waitForMarker(file: string, deadlineMs: number, stopped?: () => boolean) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text !== undefined) return text
    if (stopped?.()) return undefined
    await Bun.sleep(50)
  }
  return undefined
}

test(
  "a terminally failed store escalates into the runtime shutdown path",
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
    const exitMarker = path.join(root, "exit")
    const script = String.raw`
      import { writeFileSync } from "node:fs"
      import { writeFile } from "node:fs/promises"
      // Registered before anything else so the escalation's exit code is captured
      // even if a later exit handler stalls. Exit handlers run inside the
      // process.exit call, ahead of termination.
      process.on("exit", (code) => {
        try { writeFileSync(process.env.SYNERGY_ESCALATION_EXIT, String(code)) } catch {}
      })
      const mark = (file) => writeFile(file, "").catch(() => {})
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
        // Killing the store is the condition under test, and this rejection is the
        // same event that drives the escalation. Only a rejection before the
        // runtime ever served is a real startup failure.
        if (started) return
        console.error("runtime startup failed", error)
        process.exit(2)
      })

      const readyDeadline = Date.now() + ${STARTUP_DEADLINE_MS}
      while (Date.now() < readyDeadline) {
        try {
          if ((await fetch(getRuntimeEndpoint().url + "/global/health")).ok) { started = true; break }
        } catch {}
        await Bun.sleep(100)
      }
      if (!started) {
        console.error("runtime never became healthy")
        process.exit(3)
      }
      await mark(process.env.SYNERGY_ESCALATION_READY)

      Storage.current().store.driver.worker.kill()

      // Closing admission is the first act of the escalation, so a 503 here is
      // the escalation arriving. The marker is written only when it is actually
      // observed, so an unobserved escalation fails the assertion instead of
      // being reported by a marker that would have been written regardless.
      const escalationDeadline = Date.now() + ${ESCALATION_DEADLINE_MS}
      while (Date.now() < escalationDeadline) {
        try {
          if ((await fetch(getRuntimeEndpoint().url + "/global/health")).status === 503) {
            await mark(process.env.SYNERGY_ESCALATION_ESCALATED)
            break
          }
        } catch {}
        await Bun.sleep(25)
      }

      // Stay alive with pending work so the shutdown can drain; the escalation
      // owns the only exit that may happen, and the exit marker reports it.
      for (;;) await Bun.sleep(1_000)
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
        SYNERGY_ESCALATION_EXIT: exitMarker,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    // Start draining both streams immediately and keep them for the failure
    // messages. Startup and shutdown write more than one pipe buffer, so an
    // undrained pipe blocks the child before it can reach the escalation.
    const stdoutText = new Response(child.stdout).text()
    const stderrText = new Response(child.stderr).text()

    try {
      const exited = () => child.exitCode !== null
      const ready = await waitForMarker(readyMarker, STARTUP_DEADLINE_MS, exited)
      const escalated = await waitForMarker(escalatedMarker, ESCALATION_DEADLINE_MS, exited)
      const exitStatus = await waitForMarker(exitMarker, EXIT_DEADLINE_MS, exited)
      const observed = await Promise.race([child.exited, Bun.sleep(EXIT_CONFIRM_MS).then(() => null)])
      child.kill()
      const output = (await Promise.all([stdoutText, stderrText])).join("\n")

      // Each assertion separates a different defect: readiness distinguishes
      // "never booted" from "booted and did not escalate", the escalation marker
      // names the behaviour, the exit marker proves the escalation reached
      // `process.exit` and carries the code it passed, and the observed status
      // confirms the operating system saw the same thing.
      expect(ready, `runtime never became healthy: ${output}`).toBe("")
      expect(escalated, `storage unavailability never closed admission: ${output}`).toBe("")
      expect(exitStatus, `the escalation never reached process.exit: ${output}`).toBe("1")
      expect(observed, `the process did not exit with the escalated status: ${output}`).toBe(1)
    } finally {
      child.kill()
      await Promise.all([rm(root, { recursive: true, force: true }), isolated.dispose()])
    }
  },
  STARTUP_DEADLINE_MS + ESCALATION_DEADLINE_MS + EXIT_DEADLINE_MS + EXIT_CONFIRM_MS + 60_000,
)

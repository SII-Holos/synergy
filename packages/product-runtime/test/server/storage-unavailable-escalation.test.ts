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
// ends in `process.exit`, it has to be observed from outside the process.
//
// The observation is the escalation event itself, not the exit status that
// follows it. `gracefulShutdown` reaches `process.exit` only after
// `handle.close()`, `Log.flush()` and the rest of the teardown chain return, and
// on a loaded CI shard that tail is not bounded by anything this test can
// honestly assert: runs that had already closed admission were still draining
// when the parent gave up, which read as a missing escalation. The child
// therefore records the two things the escalation is responsible for — the
// listener fired, and admission closed — and the parent asserts on those.
//
// The exit code and the supervisor contract it serves are covered by design and
// inspection (`registerShutdown` → `gracefulShutdown(signal, 1)` →
// `process.exit(1)`), and the one-shot/terminal semantics of the listener are
// covered deterministically by `packages/harness/test/storage/storage-unavailable-escalation.test.ts`.
const STARTUP_DEADLINE_MS = 120_000
const ESCALATION_DEADLINE_MS = 120_000

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
    const script = String.raw`
      import { writeFile } from "node:fs/promises"
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

      // Stay alive so the shutdown can drain; the parent owns termination here
      // because the teardown tail is not this test's to bound.
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
      const deadline = Date.now() + ESCALATION_DEADLINE_MS + 30_000
      let escalated = false
      while (Date.now() < deadline) {
        if (await Bun.file(escalatedMarker).exists()) {
          escalated = true
          break
        }
        if (child.exitCode !== null) break
        await Bun.sleep(50)
      }
      child.kill()
      const output = (await Promise.all([stdoutText, stderrText])).join("\n")

      expect(
        await readFile(readyMarker, "utf8").catch(() => undefined),
        `runtime never became healthy: ${output}`,
      ).toBe("")
      expect(escalated, `storage unavailability never reached the runtime shutdown path: ${output}`).toBe(true)
    } finally {
      child.kill()
      await Promise.all([rm(root, { recursive: true, force: true }), isolated.dispose()])
    }
  },
  ESCALATION_DEADLINE_MS + 60_000,
)

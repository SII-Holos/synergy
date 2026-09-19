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
const CHILD_TIMEOUT_MS = 120_000

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
    const survivedMarker = path.join(root, "survived")
    const script = String.raw`
      const { Log } = await import("@ericsanchezok/synergy-harness/util/log")
      Log.init({ print: false })
      const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
      const { getRuntimeEndpoint } = await import("@ericsanchezok/synergy-harness/util/runtime-endpoint")
      const { run } = await import("./src/server/runtime")
      void run({
        interactive: false,
        printBanner: false,
        printChannelStatus: false,
        network: { hostname: "127.0.0.1", port: 0 },
      }).catch((error) => {
        console.error("runtime startup failed", error)
        process.exit(2)
      })

      const deadline = Date.now() + 60000
      let healthy = false
      while (Date.now() < deadline) {
        try {
          const response = await fetch(getRuntimeEndpoint().url + "/global/health")
          if (response.ok) { healthy = true; break }
        } catch {}
        await Bun.sleep(100)
      }
      if (!healthy) {
        console.error("runtime never became healthy")
        process.exit(3)
      }
      await Bun.write(process.env.SYNERGY_ESCALATION_READY, "")
      Storage.current().store.driver.worker.kill()
      // Escalation is one-shot and asynchronous. If it never arrives, the
      // runtime keeps serving over a dead store — the regression to catch.
      await Bun.sleep(20000)
      await Bun.write(process.env.SYNERGY_ESCALATION_SURVIVED, "")
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
        SYNERGY_ESCALATION_SURVIVED: survivedMarker,
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
        Bun.sleep(CHILD_TIMEOUT_MS).then(() => {
          child.kill()
          return -1
        }),
      ])
      const stderr = await stderrText
      await stdoutText

      expect(
        await readFile(readyMarker, "utf8").catch(() => undefined),
        `runtime never became healthy: ${stderr}`,
      ).toBe("")
      expect(await readFile(survivedMarker, "utf8").catch(() => undefined)).toBeUndefined()
      expect(exitCode, `runtime kept running over a dead store: ${stderr}`).toBe(1)
    } finally {
      child.kill()
      await Promise.all([rm(root, { recursive: true, force: true }), isolated.dispose()])
    }
  },
  CHILD_TIMEOUT_MS + 30_000,
)

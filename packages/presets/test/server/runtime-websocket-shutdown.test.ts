import { expect, test } from "bun:test"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test.skipIf(process.platform === "win32")(
  "a completed PTY WebSocket releases the full Runtime and its process",
  async () => {
    await using fixture = await runtimeHome()
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/websocket-shutdown.ts")], {
      env: {
        ...process.env,
        ...fixture.host.env,
        SYNERGY_HOME: fixture.host.home,
        SYNERGY_TEST_HOME: fixture.host.home,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 20_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stdout, stderr).toContain("terminal-completed")
      expect(timedOut, stderr).toBe(false)
      expect(code, stderr).toBe(0)
      expect(stdout).toContain("runtime-closed")
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  },
  30_000,
)

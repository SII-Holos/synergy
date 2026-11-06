import { expect, test } from "bun:test"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

for (const result of ["resolve", "reject"]) {
  test(`settled health ${result} releases its timeout and allows process exit`, async () => {
    await using fixture = await runtimeHome()
    const env = { ...process.env, ...fixture.host.env }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    delete env.SYNERGY_TEST_FILES
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/health-lifetime.ts"), result], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stdout, stderr).toContain("health-settled")
      expect(timedOut, stderr).toBe(false)
      expect(code, stderr).toBe(0)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  }, 20_000)
}

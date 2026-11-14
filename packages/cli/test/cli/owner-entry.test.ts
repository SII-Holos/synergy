import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("an explicit owner CLI exposes only supplied commands and keeps unknown commands outside the ambient Home", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixtures/owner-cli.ts"), ...args], {
        env: { ...isolation.env, SYNERGY_DESKTOP_MAINTENANCE_PROGRESS: "1", SYNERGY_DESKTOP_PARENT_PID: "invalid" },
        cwd: isolation.env.SYNERGY_TEST_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const help = await invoke(["--help"])
    expect(help.code, help.stderr).toBe(0)
    expect(help.stdout).toContain("owner-fixture independent")
    expect(help.stdout).not.toContain("send [message..]")
    expect((await invoke(["independent"])).stdout.trim()).toBe("owner-ready")
    const unknown = await invoke(["send", "never"])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unavailable")
    expect((await invoke(["migration", "run", "--maintenance"])).stdout.trim()).toBe("owner-maintenance")
    expect((await invoke(["data", "storage", "reclaim"])).stderr).toContain("unavailable")
    expect(await fs.readdir(isolation.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolation.dispose()
  }
})

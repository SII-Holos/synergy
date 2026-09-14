import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("a full offline migration activates authority and subsequent read-only status succeeds", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const entry = new URL("../../src/index.ts", import.meta.url).pathname
    for (const args of [
      ["migration", "run"],
      ["data", "storage", "status"],
    ]) {
      const child = Bun.spawn({
        cmd: [process.execPath, "run", entry, ...args],
        env: isolated.env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      if (args[0] === "data") expect(JSON.parse(stdout).phase).toBe("active")
    }
  } finally {
    await isolated.dispose()
  }
}, 30000)

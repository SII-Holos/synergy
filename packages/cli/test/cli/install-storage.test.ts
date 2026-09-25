import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("source package management refuses before opening storage or creating an invalid generation", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const root = isolated.env.SYNERGY_TEST_HOME!
    const database = path.join(root, "data/storage/agent.sqlite")
    await Bun.write(database, "invalid database fixture")
    const child = Bun.spawn(
      [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname, "install", "mcp"],
      { env: isolated.env, stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(stdout + stderr).toContain("Source runtimes compose components explicitly")
    expect(await Bun.file(path.join(root, "installations/active.json")).exists()).toBe(false)
    expect(await Bun.file(database).text()).toBe("invalid database fixture")
  } finally {
    await isolated.dispose()
  }
}, 30000)

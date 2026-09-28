import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../../src/env"
import { runTests } from "../../script/run"

test.skipIf(process.platform === "win32")(
  "the batch runner preserves a fixture's explicit detached-process lifetime",
  async () => {
    const isolated = await createIsolatedTestEnv()
    const root = isolated.env.SYNERGY_TEST_ROOT!
    try {
      await fs.mkdir(path.join(root, "test"))
      await Bun.write(path.join(root, "bunfig.toml"), "[test]\ntimeout = 15000\n")
      await Bun.write(
        path.join(root, "worker.ts"),
        `await Bun.write("ready", String(process.pid))
while (!(await Bun.file("continue").exists())) await Bun.sleep(10)
await Bun.write("completed", "after launcher exit")
`,
      )
      await Bun.write(
        path.join(root, "launcher.ts"),
        `const child = Bun.spawn([process.execPath, "worker.ts"], {
  detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env,
})
child.unref()
while (!(await Bun.file("ready").exists())) await Bun.sleep(10)
`,
      )
      await Bun.write(
        path.join(root, "test/lifetime.test.ts"),
        `import { expect, test } from "bun:test"
test("the fixture completes after its launcher exits", async () => {
  const launcher = Bun.spawn([process.execPath, "launcher.ts"], {
    cwd: ${JSON.stringify(root)}, stdout: "ignore", stderr: "ignore", env: process.env,
  })
  let pid
  try {
    expect(await launcher.exited).toBe(0)
    pid = Number(await Bun.file("ready").text())
    await Bun.write("continue", "release")
    const deadline = Date.now() + 5000
    while (!(await Bun.file("completed").exists()) && Date.now() < deadline) await Bun.sleep(10)
    expect(await Bun.file("completed").text()).toBe("after launcher exit")
  } finally {
    launcher.kill()
    if (pid) { try { process.kill(-pid, "SIGKILL") } catch {} }
  }
})
`,
      )
      expect(await runTests({ root, files: ["test/lifetime.test.ts"], coverage: false })).toBe(0)
      expect(await Bun.file(path.join(root, "completed")).text()).toBe("after launcher exit")
    } finally {
      await isolated.dispose()
    }
  },
  30_000,
)

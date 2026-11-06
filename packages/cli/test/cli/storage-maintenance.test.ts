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

test("startup diagnostics succeeds without opening a corrupt authoritative database", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const root = isolated.env.SYNERGY_TEST_HOME!
    const database = `${root}/data/storage/agent.sqlite`
    const content = "deliberately invalid database"
    await Bun.write(database, content)
    const output = `${root}/startup.tar.gz`
    const startupLog = `${root}/server.log`
    const progress = 'SYNERGY_STARTUP_V1 {"phase":"migration","step":2,"current":512,"total":0}'
    await Bun.write(
      startupLog,
      "private log content\n" + progress + '\nSYNERGY_STARTUP_V1 {"phase":"starting","secret":"private"}\n',
    )
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        new URL("../../src/index.ts", import.meta.url).pathname,
        "diagnostics",
        "--startup",
        "--output",
        output,
      ],
      env: { ...isolated.env, SYNERGY_DESKTOP_STARTUP_LOG: startupLog },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout + stderr).toContain("Diagnostics package:")
    expect(await Bun.file(database).text()).toBe(content)
    const archive = Bun.spawn(["tar", "-xOf", output, "./startup.json"], { stdout: "pipe", stderr: "pipe" })
    const report = JSON.parse(await new Response(archive.stdout).text())
    expect(await archive.exited).toBe(0)
    const logs = Bun.spawn(["tar", "-xOf", output, "./logs/server.log"], { stdout: "pipe", stderr: "pipe" })
    const summary = await new Response(logs.stdout).text()
    expect(await logs.exited).toBe(0)
    expect(summary).toContain(progress)
    expect(summary).not.toContain("private")
    expect(report.storage).toEqual({ inspected: false, reason: "Startup diagnostics does not open the database" })
  } finally {
    await isolated.dispose()
  }
}, 30000)

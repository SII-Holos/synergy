import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { runCli } from "../../src/main"

test("the measured startup diagnostics command archives safe progress without opening the database", async () => {
  const isolated = await createIsolatedTestEnv()
  const names = ["SYNERGY_HOME", "SYNERGY_RUNTIME_ROOT", "SYNERGY_DESKTOP_STARTUP_LOG"] as const
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  const code = process.exitCode ?? 0
  try {
    const root = path.join(isolated.env.SYNERGY_TEST_ROOT!, "source-diagnostics")
    const database = path.join(root, "data/storage/agent.sqlite")
    const startup = path.join(root, "server.log")
    const archive = path.join(root, "startup.tar.gz")
    const progress = 'SYNERGY_STARTUP_V1 {"phase":"migration","step":2,"current":512,"total":0}'
    const contents = "deliberately invalid database"
    await Bun.write(database, contents)
    await Bun.write(startup, "private source diagnostic body\n" + progress + "\n")
    process.env.SYNERGY_HOME = root
    process.env.SYNERGY_DESKTOP_STARTUP_LOG = startup
    delete process.env.SYNERGY_RUNTIME_ROOT
    process.exitCode = 0
    await runCli({
      argv: ["diagnostics", "--startup", "--output", archive],
      runtimeFactory: async () => {
        throw new Error("Startup diagnostics must not initialize the Agent Runtime")
      },
    })
    expect(process.exitCode).toBe(0)
    expect(await Bun.file(database).text()).toBe(contents)
    async function member(name: string) {
      const child = Bun.spawn(["tar", "-xOf", archive, name], { stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      return stdout
    }
    const report: unknown = JSON.parse(await member("./startup.json"))
    expect(report).toMatchObject({ storage: { inspected: false }, telemetry: { inspected: false } })
    const log = await member("./logs/server.log")
    expect(log).toContain(progress)
    expect(log).not.toContain("private source diagnostic body")
  } finally {
    process.exitCode = code
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await isolated.dispose()
  }
})

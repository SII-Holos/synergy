import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

for (const args of [
  ["server", "--hostname", "127.0.0.1", "--port", "0", "--non-interactive"],
  ["send", "fixture", "--format", "json", "--non-interactive", "--port", "0"],
]) {
  test(
    `${args[0]} displays startup migration progress on stderr without writing to stdout`,
    () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        const child = Bun.spawn([process.execPath, "--conditions=browser", "test/cli/fixture/migration.ts", ...args], {
          cwd: import.meta.dir + "/../..",
          env: {
            ...process.env,
            SYNERGY_HOME: `${tmp.path}/home`,
            SYNERGY_CWD: tmp.path,
            SYNERGY_DESKTOP_STARTUP_PROGRESS: undefined,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain("Starting [aaa-cli-progress-fixture] Upgrade CLI fixture records")
        expect(stderr).toContain("50% (1/2)")
        expect(stderr).toContain("✗ [aaa-cli-progress-fixture]")
        expect(stderr).toContain("CLI fixture stops before runtime admission")
        expect(stdout).toBe("")
        expect(stderr.split("✗")[0]).not.toContain("\x1b")
      }),
    30_000,
  )
}

test(
  "managed server selects structured progress at its command entry",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const child = Bun.spawn(
        [process.execPath, "--conditions=browser", "test/cli/fixture/migration.ts", "server", "--port", "0"],
        {
          cwd: import.meta.dir + "/../..",
          env: {
            ...process.env,
            SYNERGY_HOME: `${tmp.path}/home`,
            SYNERGY_CWD: tmp.path,
            SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).not.toBe(0)
      expect(stdout).toContain('SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":1,"total":2}')
      expect(stderr).not.toContain("Starting [aaa-cli-progress-fixture]")
      expect(stderr).not.toContain("50% (1/2)")
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())

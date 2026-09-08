import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

for (const args of [
  ["server", "--hostname", "127.0.0.1", "--port", "0", "--non-interactive"],
  ["send", "fixture", "--format", "json", "--non-interactive", "--port", "0"],
]) {
  test(`${args[0]} displays startup migration progress on stderr without writing to stdout`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn([process.execPath, "--conditions=browser", "test/fixture/cli-migration.ts", ...args], {
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
  }, 30_000)
}

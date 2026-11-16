import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"

for (const role of ["storage", "telemetry"] as const) {
  test(`${role} source workers do not execute Bun configuration from the caller or Runtime directory`, async () => {
    await using files = await tmpdir()
    const root = path.join(files.path, "runtime")
    const marker = path.join(files.path, "preload-ran")
    for (const directory of [files.path, root]) {
      await Bun.write(path.join(directory, ".env"), "PRIVATE_WORKER_INPUT=not-selected\n")
      await Bun.write(
        path.join(directory, "preload.ts"),
        'await Bun.write(process.env.SYNERGY_FIXTURE_PRELOAD_MARKER!, "executed")\n',
      )
      await Bun.write(path.join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    }
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        "--no-env-file",
        `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        path.join(import.meta.dir, "fixtures/worker-loader.ts"),
        root,
        role,
        marker,
      ],
      cwd: files.path,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYNERGY_TEST_HOME: files.path },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stdout, stderr).toBeTruthy()
      expect(JSON.parse(stdout)).toEqual({ completed: true, preload: false })
      expect(code, stderr).toBe(0)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }, 25_000)
}

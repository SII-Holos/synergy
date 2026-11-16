import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"

for (const role of ["agent", "policy"] as const) {
  test(`${role} worker uses its Runtime directory and explicit environment without dotenv or Bun preloads`, async () => {
    await using files = await tmpdir()
    const root = path.join(files.path, "runtime")
    await Bun.write(path.join(files.path, ".env"), "PARENT_PRIVATE_VALUE=parent-secret\n")
    await Bun.write(path.join(root, ".env"), "HOME_PRIVATE_VALUE=home-secret\n")
    for (const directory of [files.path, root]) {
      await Bun.write(path.join(directory, "preload.ts"), "process.env.PRELOAD_PRIVATE_VALUE = 'preload-secret'\n")
      await Bun.write(path.join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    }
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        "--no-env-file",
        `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        path.join(import.meta.dir, "fixtures/worker-environment.ts"),
        root,
        role,
      ],
      cwd: files.path,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYNERGY_TEST_HOME: files.path },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ cwd: root, explicit: "public" })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }, 20_000)
}

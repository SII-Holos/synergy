import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

for (const jit of ["0", "1"])
  test(`native file, process ownership and PTY bindings work with JIT=${jit}`, async () => {
    await using directory = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/native-bindings.ts"), directory.path],
      {
        env: { ...process.env, BUN_JSC_useJIT: jit },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000)
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const state = await Bun.file(path.join(directory.path, "stage.json")).json()
      expect({ code, error, state }).toEqual({ code: 0, error: "", state: { stage: "completed" } })
      expect(JSON.parse(output)).toEqual({ jit, files: true, process: true, terminal: true })
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
    }
  }, 30_000)

import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test(
  "bundled workflow delegates idle detection and clearing to the shared session service",
  () =>
    runtime.run(async () => {
      const isolation = await createIsolatedTestEnv()
      try {
        const directory = isolation.env.SYNERGY_TEST_ROOT!
        const output = path.join(directory, "bin", process.platform === "win32" ? "workflow.exe" : "workflow")
        await fs.mkdir(path.dirname(output), { recursive: true })
        if (process.platform === "darwin")
          await fs.copyFile(
            path.resolve(import.meta.dir, "../../../harness/.artifacts/sqlite/libsqlite3.dylib"),
            path.join(directory, "libsqlite3.dylib"),
          )
        const build = Bun.spawn(
          [
            process.execPath,
            "build",
            path.join(import.meta.dir, "fixture/bundled-workflow.ts"),
            "--target=bun",
            "--compile",
            "--outfile",
            output,
          ],
          {
            env: isolation.env,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()])
        expect(code, error).toBe(0)
        const run = Bun.spawn([output], {
          cwd: directory,
          env: { ...isolation.env, SYNERGY_DISABLE_MODELS_FETCH: "true" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [status, stdout, stderr] = await Promise.all([
          run.exited,
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
        ])
        expect(status, stderr).toBe(0)
        expect(stdout).toBe("workflow-cleared")
      } finally {
        await isolation.dispose()
      }
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())

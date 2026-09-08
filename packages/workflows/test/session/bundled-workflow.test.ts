import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("bundled workflow delegates idle detection and clearing to the shared session service", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const directory = isolation.env.SYNERGY_TEST_ROOT!
    const output = path.join(directory, "workflow.js")
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        path.join(import.meta.dir, "fixture/bundled-workflow.ts"),
        "--target=bun",
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
    const run = Bun.spawn([process.execPath, output], {
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
}, 30_000)

import { expect, test } from "bun:test"
import path from "path"

test("Agent worker static runtime excludes Control Plane and tool implementations", async () => {
  const packageRoot = path.resolve(import.meta.dir, "../..")
  const fixture = path.join(import.meta.dir, "fixtures/agent-worker-runtime-boundary.ts")
  const child = Bun.spawn({
    cmd: [process.execPath, "run", fixture],
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect(exitCode, stderr).toBe(0)
  const result = JSON.parse(stdout) as {
    success: boolean
    logs: string[]
    entryFound: boolean
    forbidden: string[]
  }
  expect(result.success, result.logs.join("\n")).toBe(true)
  expect(result.entryFound).toBe(true)
  expect(result.forbidden).toEqual([])
})

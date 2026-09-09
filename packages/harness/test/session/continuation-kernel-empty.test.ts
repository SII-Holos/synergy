import { describe, expect, test } from "bun:test"

describe("empty registry signature (criterion 5)", () => {
  test("propose() returns undefined and warns when no policies are registered", async () => {
    const worker = import.meta.dir + "/continuation-kernel-empty-worker.ts"
    const proc = Bun.spawn([process.execPath, "run", worker], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stdout).toContain("PROPOSE_RESULT:undefined")
    expect(stderr).toContain("continuation kernel has no policies registered")
    expect(stderr).toContain("service=session.continuation-kernel")
  }, 30_000)
})

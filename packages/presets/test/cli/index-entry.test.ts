import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("index.ts bootstrap reaches the CLI and completes", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "--help"],
    {
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(20_000),
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("synergy install")
    expect(stdout).toContain("synergy server")
  } finally {
    child.kill()
    await child.exited
  }
}, 30_000)

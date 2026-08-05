import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

async function runEmbed(args: string[], env?: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", "embed", ...args], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, exitCode }
}

describe("embed download CLI", () => {
  test("resolves config inside scope context and reports remote mode without crashing", async () => {
    await using tmp = await tmpdir()

    const result = await runEmbed(["download"], {
      SYNERGY_CWD: tmp.path,
      SYNERGY_CONFIG_CONTENT: JSON.stringify({ embedding: { apiKey: "test-key" } }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("No download needed")
    expect(result.output).not.toContain("No context found for scope")
  })
})

import { describe, expect, test } from "bun:test"

async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", ...args], {
    cwd: import.meta.dir + "/../..",
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, output: stdout + stderr }
}

describe("browser CLI", () => {
  test("registers doctor and install under the browser command", async () => {
    const result = await cli(["browser", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("browser doctor")
    expect(result.output).toContain("browser install")
  })

  test("documents machine-readable doctor output", async () => {
    const result = await cli(["browser", "doctor", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("--json")
    expect(result.output).toMatch(/diagnos|readiness/i)
  })

  test("documents explicit managed Chromium installation", async () => {
    const result = await cli(["browser", "install", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("--force")
    expect(result.output).toContain("--json")
    expect(result.output).toContain("--no-deps")
    expect(result.output).toMatch(/verified|managed Chromium/i)
  })

  test("exposes Linux dependency installation separately", async () => {
    const result = await cli(["browser", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("browser install-deps")
  })
})

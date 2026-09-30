import { describe, expect, test } from "bun:test"

async function cli(args: string[], desktop: boolean) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", ...args], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, SYNERGY_DESKTOP_BROWSER: desktop ? "1" : "0" },
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

describe("browser CLI boundary", () => {
  for (const desktop of [false, true])
    test(`${desktop ? "Desktop" : "CLI"} selection exposes no independent browser installer`, async () => {
      const result = await cli(["--help"], desktop)

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain("synergy server")
      expect(result.output).not.toMatch(/synergy browser|browser (?:doctor|install|install-deps)/)
    })
})

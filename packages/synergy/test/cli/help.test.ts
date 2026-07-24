import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

async function cliHelp(args: string[], env?: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", ...args], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return stdout + stderr
}

describe("product CLI help", () => {
  test("does not persist the launch directory while discovering plugin commands", async () => {
    await using tmp = await tmpdir()

    await cliHelp(["--help"], { SYNERGY_CWD: tmp.path })

    expect((await Scope.list()).some((scope) => scope.worktree === tmp.path)).toBe(false)
  })

  test("does not expose source checkout dev commands", async () => {
    const help = await cliHelp(["--help"])

    expect(help).not.toContain("synergy prepare")
    expect(help).not.toContain("synergy build")
  })

  test("web command opens a running server and no longer starts Vite", async () => {
    const help = await cliHelp(["web", "--help"])

    expect(help).toContain("--attach")
    expect(help).not.toContain("--dev")
    expect(help).not.toContain("Vite")
  })
})

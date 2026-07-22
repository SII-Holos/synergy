import { describe, expect, test } from "bun:test"

async function cliHelp(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", ...args], {
    cwd: import.meta.dir + "/../..",
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

  test("tui command documents runtime and Scope attachment options", async () => {
    const rootHelp = await cliHelp(["--help"])
    const help = await cliHelp(["tui", "--help"])

    expect(rootHelp).toContain("tui")
    expect(help).toContain("--attach")
    expect(help).toContain("--directory")
    expect(help).toContain("--scope")
    expect(help).toContain("--session")
    expect(help).toContain("--theme")
  })
})

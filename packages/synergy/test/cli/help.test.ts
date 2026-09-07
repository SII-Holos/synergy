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
  test("help and version leave broken configuration, caches and migration state untouched", async () => {
    await using tmp = await tmpdir()
    const cache = `${tmp.path}/.synergy/cache`
    const config = `${tmp.path}/.synergy/config/synergy.d/120-runtime.jsonc`
    await Bun.write(`${cache}/version`, "outdated")
    await Bun.write(`${cache}/keep`, "sentinel")
    await Bun.write(config, "{ invalid }")
    await Bun.write(`${tmp.path}/.synergy/plugin.lock`, "{ invalid }")
    const files = () =>
      Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: tmp.path, onlyFiles: true, dot: true })).then((files) =>
        files.sort(),
      )
    const before = await files()
    for (const args of [["--help"], ["send", "--help"], ["--version"]])
      await cliHelp(args, { SYNERGY_HOME: tmp.path, SYNERGY_CWD: tmp.path })
    expect(await files()).toEqual(before)
    expect(await Bun.file(`${cache}/version`).text()).toBe("outdated")
    expect(await Bun.file(`${cache}/keep`).text()).toBe("sentinel")
    expect(await Bun.file(config).text()).toBe("{ invalid }")
  })
  test("snapshot maintenance exposes scope selection and explicit collection controls", async () => {
    const group = await cliHelp(["data", "snapshots", "--help"])
    for (const action of ["inspect", "check", "migrate", "compact", "clean"]) expect(group).toContain(action)
    const compact = await cliHelp(["data", "snapshots", "compact", "--help"])
    for (const flag of ["--scope", "--json", "--apply", "--prune"]) expect(compact).toContain(flag)
  })
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

  test("send documents explicit scope selection and cwd fallback", async () => {
    const help = await cliHelp(["send", "--help"])

    expect(help).toContain("--scope")
    expect(help).toContain("registered scope id")
    expect(help).toContain("current directory")
  })

  test("send documents the lightloop workflow option", async () => {
    const help = await cliHelp(["send", "--help"])

    expect(help).toContain("--workflow")
    expect(help).toContain("lightloop")
  })

  test("web command opens a running server and no longer starts Vite", async () => {
    const help = await cliHelp(["web", "--help"])

    expect(help).toContain("--attach")
    expect(help).not.toContain("--dev")
    expect(help).not.toContain("Vite")
  })
})

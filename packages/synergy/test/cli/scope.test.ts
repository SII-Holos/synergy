import { describe, expect, test } from "bun:test"
import { resolveCliScope } from "../../src/cli/scope"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

async function runSend(args: string[], env?: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", "send", ...args], {
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

describe("resolveCliScope", () => {
  test("resolves an explicitly selected registered scope without registering the launch directory", async () => {
    await using project = await tmpdir()
    await using launch = await tmpdir()
    const projectScope = await project.scope()

    const resolved = await resolveCliScope({ fallbackDirectory: launch.path, scopeID: projectScope.id })

    expect(resolved.id).toBe(projectScope.id)
    expect(resolved.directory).toBe(project.path)
    expect((await Scope.list()).some((scope) => scope.worktree === launch.path)).toBe(false)
  })

  test("rejects an unknown explicit scope instead of falling back to the launch directory", async () => {
    await using launch = await tmpdir()

    expect(resolveCliScope({ fallbackDirectory: launch.path, scopeID: "missing-scope" })).rejects.toThrow(
      "Scope not found: missing-scope",
    )
    expect((await Scope.list()).some((scope) => scope.worktree === launch.path)).toBe(false)
  })

  test("keeps automatic directory registration when no scope is selected", async () => {
    await using launch = await tmpdir()

    const resolved = await resolveCliScope({ fallbackDirectory: launch.path })

    expect(resolved.type).toBe("project")
    expect(resolved.directory).toBe(launch.path)
    // Scope.list() filters ephemeral test-artifact worktrees; verify the
    // persisted record directly via fromID.
    expect((await Scope.fromID(resolved.id))?.type).toBe("project")
  })
})

describe("send --scope", () => {
  test("rejects an unknown local scope before starting a private runtime", async () => {
    await using launch = await tmpdir()

    const result = await runSend(["--scope", "local-missing", "hello"], { SYNERGY_CWD: launch.path })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Scope not found: local-missing")
    expect((await Scope.list()).some((scope) => scope.worktree === launch.path)).toBe(false)
  })

  test("sends an explicit scope id to an attached runtime without registering the launch directory", async () => {
    await using launch = await tmpdir()
    const received = { scopeID: undefined as string | undefined }
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        received.scopeID = request.headers.get("x-synergy-scope-id") ?? undefined
        return Response.json(
          { name: "ScopeNotFound", data: { message: "Scope not found: remote-missing" } },
          { status: 404 },
        )
      },
    })

    const result = await runSend(["--attach", server.url.toString(), "--scope", "remote-missing", "hello"], {
      SYNERGY_CWD: launch.path,
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Scope not found: remote-missing")
    expect(received.scopeID).toBe("remote-missing")
    expect((await Scope.list()).some((scope) => scope.worktree === launch.path)).toBe(false)
  })
})

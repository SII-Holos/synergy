import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { openLocalRuntime } from "../src"
import { Worktree } from "../src/workspace/worktree"

test("real worktree bindings survive current selection and detach on none or session deletion", async () => {
  await using fixture = await runtimeHome()
  const directory = path.join(fixture.host.home, "project")
  await fs.mkdir(directory)
  for (const args of [
    ["init"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
  ]) {
    const process = Bun.spawn(["git", ...args], {
      cwd: directory,
      env: { ...fixture.host.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(await process.exited).toBe(0)
  }
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(directory)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create()
        const bound = await Session.applyWorkspaceSelection(session.id, { mode: "create", name: "owned" })
        expect(bound.workspace?.type).toBe("git_worktree")
        expect((await Session.applyWorkspaceSelection(session.id, { mode: "current" })).workspace).toEqual(
          bound.workspace,
        )
        expect((await Worktree.list()).find((item) => item.path === bound.workspace?.path)?.bindings).toContain(
          session.id,
        )
        const lease = SessionManager.acquire(session.id)!
        try {
          await expect(Session.applyWorkspaceSelection(session.id, { mode: "none" })).rejects.toThrow()
          expect((await Session.get(session.id)).workspace).toEqual(bound.workspace)
        } finally {
          await SessionManager.finish(lease, { requestNextWork: false })
        }
        await Session.applyWorkspaceSelection(session.id, { mode: "none" })
        expect((await Session.get(session.id)).workspace).toBeNull()
        expect((await Worktree.list()).find((item) => item.path === bound.workspace?.path)?.bindings).not.toContain(
          session.id,
        )
        await Session.applyWorkspaceSelection(session.id, {
          mode: "existing",
          target: String(bound.workspace?.worktreeID),
        })
        await Session.remove(session.id)
        expect((await Worktree.list()).find((item) => item.path === bound.workspace?.path)?.bindings).not.toContain(
          session.id,
        )
      },
    })
  })
}, 30_000)

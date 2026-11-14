import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"

test("an externally identified project binds one explicit local root without deriving another Scope", async () => {
  await using runtime = await testRuntime()
  await using first = await tmpdir()
  await using second = await tmpdir()
  await runtime.run(async () => {
    const project = await Scope.registerProject({
      type: "project",
      id: "org-project",
      local: null,
      name: "Organization project",
      time: { created: 1, updated: 1 },
    })
    const local = { directory: first.path, worktree: first.path, sandboxes: [] }
    const bound = await Scope.bindLocal({ scopeID: project.id, expectedLocal: null, local })
    expect(bound.id).toBe(project.id)
    expect(bound.local).toEqual(local)
    const current = await Scope.registerProject({ ...project, local: null })
    expect(current.local).toEqual(local)
    const created = await ScopeContext.provide({
      scope: bound,
      fn: () => Session.create({ scope: bound, environmentID: null }),
    })
    expect(created.workspace?.path).toBe(first.path)
    await expect(
      Scope.bindLocal({
        scopeID: project.id,
        expectedLocal: null,
        local: { ...local, directory: second.path, worktree: second.path },
      }),
    ).rejects.toThrow("changed")
    const rebound = await Scope.bindLocal({
      scopeID: project.id,
      expectedLocal: local,
      local: { ...local, directory: second.path, worktree: second.path },
    })
    expect(rebound.local?.directory).toBe(second.path)
    expect((await Session.get(created.id)).workspace?.path).toBe(first.path)
    expect((await Scope.list()).map((scope) => scope.id)).toEqual([project.id])
  })
})

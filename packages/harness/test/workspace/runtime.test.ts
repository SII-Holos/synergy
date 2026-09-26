import { expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { ScopeStartup } from "../../src/scope/startup"
import { WorkspaceState } from "../../src/workspace/state"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Session } from "../../src/session"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("Workspace services share a generation and isolate sibling directories", async () => {
  const started: string[] = []
  const disposed: string[] = []
  const resource = WorkspaceState.create(
    () => ({ identity: crypto.randomUUID(), path: ScopeContext.current.directory }),
    async (value) => {
      disposed.push(value.path)
    },
  )
  await using runtime = await testRuntime({
    register() {
      ScopeStartup.register({
        name: "workspace-test-service",
        phase: "surface",
        owner: "workspace",
        init() {
          started.push(resource().identity)
        },
      })
    },
  })
  await runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const scope = await first.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    const read = (workspace: Session.Info["workspace"]) =>
      ScopeRuntime.provide({ scope, workspace, fn: () => resource() })
    const [a, b, a2] = await Promise.all([
      read(sessions[0]!.workspace),
      read(sessions[1]!.workspace),
      read(sessions[0]!.workspace),
    ])
    expect(a).toBe(a2)
    expect(b).not.toBe(a)
    expect([a.path, b.path]).toEqual([first.path, second.path])
    expect(started).toHaveLength(2)
    const original = await WorkspaceCatalog.get(sessions[0]!.workspaceID!, scope.id)
    await WorkspaceCatalog.rebind(original.id, {
      scopeID: scope.id,
      hostID: original.binding.hostID,
      expectedRevision: original.revision,
      path: first.path,
      physicalID: original.binding.physicalID,
    })
    await expect(read(sessions[0]!.workspace)).rejects.toThrow("binding changed")
    const rebound = await ScopeContext.provide({ scope, fn: () => Session.get(sessions[0]!.id) })
    const fresh = await read(rebound.workspace)
    expect(fresh.identity).not.toBe(a.identity)
    expect(disposed).toContain(first.path)
    await ScopeRuntime.dispose(scope.id)
    expect(disposed).toHaveLength(3)
  })
})

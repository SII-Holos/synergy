import { expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { ScopeStartup } from "../../src/scope/startup"
import { WorkspaceState } from "../../src/workspace/state"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Session } from "../../src/session"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Tool } from "../../src/tool/tool"
import { EnvironmentResources } from "../../src/environment/resources"

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

test("logical Workspace state has no filesystem prerequisite and remains owned by its Runtime", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  const disposed: string[] = []
  const state = WorkspaceState.create(
    () => ({ id: crypto.randomUUID() }),
    async (value) => {
      disposed.push(value.id)
    },
  )
  const workspace = { id: "wsp_logical", generation: 1, scopeID: "scope" }
  await first.run(() =>
    WorkspaceState.provide(workspace, async () => {
      const value = state()
      expect(state()).toBe(value)
      expect(WorkspaceState.provide({ ...workspace, generation: 2 }, state)).not.toBe(value)
      await second.run(async () => {
        expect(() => state()).toThrow("another Runtime")
        const other = WorkspaceState.provide(workspace, state)
        expect(other).not.toBe(value)
        await WorkspaceState.disposeWorkspace(workspace.id)
        expect(disposed).toEqual([other.id])
      })
      expect(state()).toBe(value)
      await WorkspaceState.disposeWorkspace(workspace.id)
      expect(disposed).toContain(value.id)
    }),
  )
})

test("logical Workspace startup runs once through tools and Scope routes without a local projection", async () => {
  const started: string[] = []
  await using runtime = await testRuntime({
    register() {
      ScopeStartup.register({
        name: "logical-service",
        phase: "surface",
        owner: "workspace",
        init() {
          expect(ScopeContext.current.workspace).toBeNull()
          started.push(WorkspaceState.key())
        },
      })
    },
  })
  await runtime.run(async () => {
    await using fixture = await tmpdir()
    const scope = await fixture.scope()
    const workspace = await WorkspaceCatalog.create({ scopeID: scope.id, backend: { provider: "objects", spec: {} } })
    const selection = { scopeID: scope.id, workspaceID: workspace.id, needs: { workspace: true } }
    await using resources = await EnvironmentResources.resolve(selection)
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        await Tool.withWorkspace(false, { resources }, async () => {})
        await Tool.withWorkspace(true, { resources }, async () => {})
      },
    })
    expect(started).toHaveLength(1)
    await WorkspaceState.provide({ id: workspace.id, scopeID: scope.id, generation: 1 }, () =>
      EnvironmentResources.provide(resources, "request", () =>
        ScopeRuntime.provide({ scope, workspace: null, fn: () => {} }),
      ),
    )
    expect(started).toHaveLength(1)
    await ScopeRuntime.dispose(scope.id)
  })
})

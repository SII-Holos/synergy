import { expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { workbench } from "../../src/component"
import { Vcs } from "../../src/project/vcs"

async function fixture() {
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  const runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        workbench().register()
        host = EnvironmentOrigin.registerHost("vcs-origin-fixture")
      },
    },
  })
  return {
    ...runtime,
    origin() {
      if (!host) throw new Error("Fixture Host was not registered")
      return host.capture("original-request")
    },
  }
}

test("native branch reads reject missing and foreign resource origins before initialization and cache access", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const workspace = ScopeContext.current.workspace!
        await using resources = await EnvironmentResources.resolve({
          scopeID: scope.id,
          workspaceID: workspace.id,
          workspaceGeneration: workspace.generation,
          origin: runtime.origin(),
          needs: { workspace: true },
        })
        const missing = { ...resources, origin: undefined }
        await expect(EnvironmentResources.provide(missing, "missing-initial-origin", () => Vcs.init())).rejects.toThrow(
          "origin",
        )
        try {
          const reference = { id: workspace.id!, scopeID: scope.id, generation: workspace.generation! }
          const changing = { ...reference }
          const starting = WorkspaceState.provide(changing, () =>
            EnvironmentResources.provide(resources, "initial-request", () => Vcs.branch()),
          )
          changing.id = "replacement"
          changing.generation++
          expect(await starting).toBeString()
          expect(await Environment.list(scope.id)).toEqual([])
          const changes: Array<{ workspaceID: string; workspaceGeneration: number; branch?: string }> = []
          const unsubscribe = WorkspaceEvents.subscribe(Vcs.Event.BranchUpdated, (event) => {
            changes.push(event.properties)
          })
          try {
            await $`git checkout -b pinned-generation`.cwd(directory.path).quiet()
            await WorkspaceEvents.publish(FileWatcher.Event.Updated, { file: ".git/HEAD", event: "changed" })
            const deadline = Date.now() + 5000
            while ((await Vcs.branch()) !== "pinned-generation") {
              if (Date.now() > deadline) throw new Error("Native branch observation did not refresh")
              await Bun.sleep(10)
            }
            expect(changes).toEqual([
              { workspaceID: reference.id, workspaceGeneration: reference.generation, branch: "pinned-generation" },
            ])
          } finally {
            unsubscribe()
          }
          await expect(
            EnvironmentResources.provide(missing, "missing-cached-origin", () => Vcs.branch()),
          ).rejects.toThrow("origin")
          const foreign = await TransactionalStore.open({
            backend: "sqlite",
            filename: path.join(directory.path, "foreign.sqlite"),
            namespace: "foreign",
          })
          try {
            await Storage.provide({ store: foreign, artifactDirectory: directory.path }, async () => {
              await expect(
                EnvironmentResources.provide(resources, "foreign-cached-origin", () => Vcs.branch()),
              ).rejects.toThrow("Storage handle")
              await expect(Vcs.branch()).rejects.toThrow("Storage handle")
            })
          } finally {
            await foreign.close()
          }
        } finally {
          await WorkspaceState.disposeWorkspace(workspace.id!)
        }
      },
    })
  })
}, 15000)

test("branch admission rechecks the original Task after watcher preparation and on later cached reads", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const workspace = ScopeContext.current.workspace!
        const session = await Session.create({ environmentID: null, workspaceID: workspace.id })
        const rootID = Identifier.ascending("message")
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          rootID,
          isRoot: true,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        const owner = RolloutLifecycle.owner(session)
        await RolloutLedger.beginRun(owner, rootID)
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: rootID,
          rootID,
          agent: "general",
          modelID: "fixture",
          providerID: "fixture",
          mode: "default",
          time: { created: 2 },
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await RolloutLedger.beginTool({ owner, runID: rootID, messageID, toolCallID: "vcs", tool: "vcs", args: {} })
        const origin = EnvironmentOrigin.selected({
          kind: "session",
          scopeID: scope.id,
          sessionID: session.id,
          rootID,
          runID: rootID,
          messageID,
          callID: "vcs",
          tool: "vcs",
        })
        await using resources = await EnvironmentResources.resolve({
          scopeID: scope.id,
          workspaceID: workspace.id,
          workspaceGeneration: workspace.generation,
          origin,
          needs: { workspace: true },
        })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const validate = WorkspaceBinding.validate
        const held = spyOn(WorkspaceBinding, "validate").mockImplementationOnce(async (...args) => {
          const value = await validate(...args)
          entered.resolve()
          await release.promise
          return value
        })
        const pending = EnvironmentResources.provide(resources, "first-task", () => Vcs.branch())
        void pending.catch(() => {})
        try {
          await entered.promise
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          release.resolve()
          await expect(pending).rejects.toThrow("native effect")
          expect(await Vcs.branch()).toBeString()
          await expect(
            EnvironmentResources.provide(resources, "paused-cached-task", () => Vcs.branch()),
          ).rejects.toThrow("native effect")
          expect(await Environment.list(scope.id)).toEqual([])
        } finally {
          release.resolve()
          held.mockRestore()
          await pending.catch(() => {})
          await WorkspaceState.disposeWorkspace(workspace.id!)
        }
      },
    })
  })
}, 15000)

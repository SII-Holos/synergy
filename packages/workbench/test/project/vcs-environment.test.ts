import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { WorktreeProcess } from "@ericsanchezok/synergy-local-runtime/workspace/process"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Vcs } from "../../src/project/vcs"
import { workbench } from "../../src/component"

test("branch observation owns its polls after the startup Task closes and follows activation and detachment", async () => {
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        workbench().register()
        host = EnvironmentOrigin.registerHost("vcs-fixture")
        WorkspaceBlobs.register("fixture", {
          put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
          get: (hash) => Storage.readBinary(["test_blobs", hash]),
        })
      },
    },
  })
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const workspace = await WorkspaceCatalog.create({
      scopeID: scope.id,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "vcs", provider: "native", spec: {} })
    if (!host) throw new Error("Fixture Host was not registered")
    const selection = {
      scopeID: scope.id,
      workspaceID: workspace.id,
      workspaceGeneration: workspace.binding.generation,
      environmentID: environment.id,
      origin: host.capture("repository-fixture"),
    }
    await using dormant = await EnvironmentResources.resolve({ ...selection, needs: { workspace: true } })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: () =>
        WorkspaceState.provide({ id: workspace.id, scopeID: scope.id, generation: 1 }, () =>
          (async () => {
            const provider = EnvironmentProviders.get("native")
            const allocate = provider.allocate
            let allocations = 0
            const observed = spyOn(provider, "allocate").mockImplementation((...args) => {
              allocations++
              return allocate(...args)
            })
            const changes: Array<{ workspaceID: string; workspaceGeneration: number; branch?: string }> = []
            const unsubscribe = WorkspaceEvents.subscribe(Vcs.Event.BranchUpdated, (event) => {
              changes.push(event.properties)
            })
            try {
              await WorkspaceAccess.task({ workspace: null }, () =>
                EnvironmentResources.provide(dormant, "startup-task", async () => {
                  expect(await Vcs.branch()).toBeUndefined()
                }),
              )
              expect(allocations).toBe(0)
              expect((await Environment.get(environment.id, scope.id)).allocation).toBeUndefined()
              expect(await Environment.uses(environment.id)).toEqual([])
              {
                await using resources = await EnvironmentResources.resolve({
                  ...selection,
                  needs: { execution: "exec" },
                })
                await EnvironmentResources.provide(resources, "create-repository", async () => {
                  for (const args of [
                    ["init", "--initial-branch", "observed"],
                    [
                      "-c",
                      "user.name=Test",
                      "-c",
                      "user.email=test@example.invalid",
                      "commit",
                      "--allow-empty",
                      "-m",
                      "fixture",
                    ],
                  ])
                    expect(
                      (
                        await WorktreeProcess.run({
                          command: ["git", ...args],
                          directory: resources.directory!,
                          roots: [resources.directory!],
                        })
                      ).exitCode,
                    ).toBe(0)
                })
              }
              const resync = () =>
                WorkspaceEvents.publish(FileWatcher.Event.Updated, { file: "", event: "changed", resync: true })
              const wait = async (expected: string | undefined) => {
                const deadline = Date.now() + 5000
                while ((await Vcs.branch()) !== expected) {
                  if (Date.now() > deadline) throw new Error("Branch observation did not refresh")
                  await Bun.sleep(10)
                }
              }
              await resync()
              await wait("observed")
              const executions = await Promise.all(
                (await Storage.queryKeys({ prefix: ["environment_execution", scope.id], limit: 64 })).map((key) =>
                  EnvironmentExecution.get(key.at(-1)!, scope.id),
                ),
              )
              expect(
                executions.some((execution) => execution.origin.kind === "host" && execution.origin.owner === "vcs"),
              ).toBe(true)
              expect(allocations).toBe(1)
              expect(changes).toEqual([{ workspaceID: workspace.id, workspaceGeneration: 1, branch: "observed" }])
              await Environment.deallocate(environment.id, { scopeID: scope.id })
              await resync()
              await wait(undefined)
              expect((await Environment.get(environment.id, scope.id)).state).toBe("idle")
              expect(allocations).toBe(1)
              expect(changes.at(-1)).toEqual({ workspaceID: workspace.id, workspaceGeneration: 1 })
            } finally {
              observed.mockRestore()
              unsubscribe()
              await WorkspaceState.disposeWorkspace(workspace.id)
            }
          })(),
        ),
    })
  })
}, 15000)

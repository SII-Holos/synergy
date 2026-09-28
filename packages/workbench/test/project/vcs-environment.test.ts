import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { WorktreeProcess } from "@ericsanchezok/synergy-local-runtime/workspace/process"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { Vcs } from "../../src/project/vcs"

test("branch observation follows a logical Workspace through activation and detachment", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
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
    const selection = { scopeID: scope.id, workspaceID: workspace.id, environmentID: environment.id }
    await using dormant = await EnvironmentResources.resolve({ ...selection, needs: { workspace: true } })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: () =>
        WorkspaceState.provide({ id: workspace.id, scopeID: scope.id, generation: 1 }, () =>
          EnvironmentResources.provide(dormant, "vcs", async () => {
            expect(await Vcs.branch()).toBeUndefined()
            expect((await Environment.get(environment.id, scope.id)).allocation).toBeUndefined()
            {
              await using resources = await EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
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
            await Environment.deallocate(environment.id, { scopeID: scope.id })
            await resync()
            await wait(undefined)
            expect((await Environment.get(environment.id, scope.id)).state).toBe("idle")
            await WorkspaceState.disposeWorkspace(workspace.id)
          }),
        ),
    })
  })
}, 15000)

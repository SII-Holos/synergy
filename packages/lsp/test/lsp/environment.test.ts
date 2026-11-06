import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { registerConfig } from "../../src/config-schema"
import { LSP } from "../../src"

test("LSP uses a logical Workspace's Environment, coexists with writes, and survives allocation relocation", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
      },
    },
    register() {
      registerConfig()
      WorkspaceBlobs.register("lsp", {
        put: (hash, bytes) => Storage.writeBinary(["lsp", hash], bytes),
        get: (hash) => Storage.readBinary(["lsp", hash]),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Config.updateGlobal({
          lsp: { fixture: { command: [process.execPath, "server.cjs"], extensions: [".fixture"] } },
        })
        const scopeID = Scope.home().id
        const workspace = await WorkspaceCatalog.create({
          scopeID,
          backend: { provider: "objects", spec: { blobStore: "lsp" } },
        })
        const selection = { scopeID, workspaceID: workspace.id }
        const source = new TextEncoder().encode("source from the selected view")
        await WorkspaceContent.write(selection, { path: "source.fixture", data: source, expectedVersion: null })
        await WorkspaceContent.write(selection, {
          path: "server.cjs",
          data: new Uint8Array(await Bun.file(path.join(import.meta.dir, "fixtures/owner-server.cjs")).arrayBuffer()),
          expectedVersion: null,
        })
        const environment = await Environment.bind({ scopeID, ownerID: "lsp", provider: "native", spec: {} })
        let firstDirectory: string | undefined
        for (const iteration of [0, 1]) {
          await using resources = await EnvironmentResources.resolve({
            ...selection,
            environmentID: environment.id,
            needs: { execution: "exec", workspace: true },
          })
          if (iteration === 0) firstDirectory = resources.directory
          else expect(resources.directory).not.toBe(firstDirectory)
          await WorkspaceState.provide({ id: workspace.id, scopeID, generation: workspace.binding.generation }, () =>
            EnvironmentResources.provide(resources, `lsp-${iteration}`, async () => {
              try {
                const file = resources.directory! + "/source.fixture"
                expect(await LSP.hasClients(file)).toBe(true)
                await LSP.touchFile(file, true)
                expect((await LSP.diagnostics())[file]?.[0]?.message).toBe("fixture warning")
                expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
                expect((await Environment.uses(environment.id)).some((use) => use.kind === "operation")).toBe(true)
                await WorkspaceOperations.write({
                  id: `competing-writer-${iteration}`,
                  ...selection,
                  path: "source.fixture",
                  data: source,
                  expectedVersion: `sha256:${WorkspaceTree.hash(source)}`,
                })
                expect(await LSP.status()).toEqual([{ id: "fixture", name: "fixture", root: "", status: "connected" }])
                expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
              } finally {
                await LSP.reload()
              }
            }),
          )
          await resources.release()
          await Environment.deallocate(environment.id, { scopeID })
          expect((await WorkspaceCatalog.get(workspace.id, scopeID)).activeMount).toBeUndefined()
        }
      },
    }),
  )
}, 30_000)

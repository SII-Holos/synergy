import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { File } from "@ericsanchezok/synergy-local-runtime/file"
import { registerConfig } from "../../src/config-schema"
import { Format } from "../../src"

test("configured formatters use the active Environment and leave dormant object edits allocation-free", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        registerConfig()
      },
    },
    register() {
      WorkspaceBlobs.register("format", {
        put: (hash, bytes) => Storage.writeBinary(["format", hash], bytes),
        get: (hash) => Storage.readBinary(["format", hash]),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Config.updateGlobal({
          formatter: {
            fixture: {
              command: [process.execPath, "-e", "await Bun.write(process.argv[1], 'formatted')", "$FILE"],
              extensions: [".fixture"],
            },
          },
        })
        const scopeID = Scope.home().id
        const workspace = await WorkspaceCatalog.create({
          scopeID,
          backend: { provider: "objects", spec: { blobStore: "format" } },
        })
        const environment = await Environment.bind({ scopeID, ownerID: "format", provider: "native", spec: {} })
        const selection = { scopeID, workspaceID: workspace.id, environmentID: environment.id }
        await WorkspaceContent.write(selection, {
          path: "file.fixture",
          data: new TextEncoder().encode("original"),
          expectedVersion: null,
        })
        for (const live of [false, true]) {
          await using resources = await EnvironmentResources.resolve({
            ...selection,
            needs: live ? { execution: "exec" } : { workspace: true },
          })
          await WorkspaceState.provide({ id: workspace.id, scopeID, generation: workspace.binding.generation }, () =>
            EnvironmentResources.provide(resources, `format-${live}`, async () => {
              Format.init()
              await WorkspaceEvents.publish(File.Event.Edited, {
                file: resources.directory ? resources.directory + "/file.fixture" : "file.fixture",
                contentVersion: FileTime.version("original"),
              })
              await Format.reload()
            }),
          )
          await resources.release()
          if (live) await Environment.deallocate(environment.id, { scopeID })
          else expect((await Environment.get(environment.id, scopeID)).generation).toBe(0)
          expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "file.fixture"))).toBe(
            live ? "formatted" : "original",
          )
        }
      },
    }),
  )
}, 20000)

import { expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { dockerEnvironment } from "@ericsanchezok/synergy-local-runtime/environment/docker"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import definition from "./fixtures/workspace-plugin"
import { testRuntime } from "../support/runtime"

const image = process.env.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE

for (const mode of ["process", "inProcess"] as const)
  test(`plugin ${mode} reads and writes dormant object storage without compute or controller paths`, async () => {
    await using runtime = await testRuntime({
      register() {
        WorkspaceBlobs.register("fixture", {
          put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
          get: (hash) => Storage.readBinary(["test_blobs", hash]),
        })
      },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceCatalog.create({
            scopeID: scope.id,
            backend: { provider: "objects", spec: { blobStore: "fixture" } },
          })
          const selection = { workspaceID: workspace.id, scopeID: scope.id }
          await WorkspaceContent.write(selection, { path: "file", data: Buffer.from("before"), expectedVersion: null })
          await Bun.write(path.join(tmp.path, "file"), "controller")
          const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
          const manifest = compilePluginManifest(definition, {
            generation: "logical-workspace",
            runtime: { entry: "runtime/index.js", sha256: "test" },
          })
          const entryPath = path.join(import.meta.dir, "fixtures/workspace-plugin.ts")
          const manager = pluginRuntimeManager()
          await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath), mode, trustedBuiltin: true })
          try {
            expect(
              await manager.invoke({
                pluginId: manifest.id,
                handlerId: "operation:edit",
                value: { path: "file", content: "after" },
                context: { scopeId: scope.id, sessionId: session.id, directory: tmp.path, actor: { type: "ui" } },
                pluginDir: path.dirname(entryPath),
                manifest,
              }),
            ).toEqual({ before: "before", after: "after" })
            expect(Buffer.from(await WorkspaceContent.read(selection, "file")).toString()).toBe("after")
            expect(await Environment.list(scope.id)).toHaveLength(0)
            expect(await Bun.file(path.join(tmp.path, "file")).text()).toBe("controller")
          } finally {
            await manager.stop(manifest.id)
          }
        },
      })
    })
  })

for (const providerID of ["native", "docker"] as const)
  test.skipIf(providerID === "docker" && !image)(
    `plugin shell and file services share the ${providerID} live view and checkpoint`,
    async () => {
      const docker =
        providerID === "docker"
          ? dockerEnvironment({
              id: "fixture-docker",
              endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
            })
          : undefined
      await using runtime = await testRuntime({
        register() {
          if (docker) EnvironmentProviders.register(docker)
          WorkspaceBlobs.register("fixture", {
            put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
            get: (hash) => Storage.readBinary(["test_blobs", hash]),
          })
        },
      })
      await runtime.run(async () => {
        await using tmp = await tmpdir({ config: { controlProfile: "full_access" } })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          workspace: null,
          fn: async () => {
            const workspace = await WorkspaceCatalog.create({
              scopeID: scope.id,
              backend: { provider: "objects", spec: { blobStore: "fixture" } },
            })
            const selection = { workspaceID: workspace.id, scopeID: scope.id }
            await WorkspaceContent.write(selection, {
              path: "file",
              data: Buffer.from("before"),
              expectedVersion: null,
            })
            await Bun.write(path.join(tmp.path, "file"), "controller")
            const environment = await Environment.bind({
              scopeID: scope.id,
              ownerID: "plugin",
              provider: docker?.id ?? providerID,
              spec: docker ? { image: image! } : {},
            })
            const session = await Session.create({ workspaceID: workspace.id, environmentID: environment.id })
            expect((await Environment.get(environment.id, scope.id)).allocation).toBeUndefined()
            const manifest = compilePluginManifest(definition, {
              generation: "environment-workspace",
              runtime: { entry: "runtime/index.js", sha256: "test" },
            })
            const entryPath = path.join(import.meta.dir, "fixtures/workspace-plugin.ts")
            const manager = pluginRuntimeManager()
            await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath) })
            const command = docker
              ? ["/bin/sh", "-c", "printf ':shell' >> file"]
              : [process.execPath, "-e", "await Bun.write('file', (await Bun.file('file').text()) + ':shell')"]
            try {
              expect(
                await manager.invoke({
                  pluginId: manifest.id,
                  handlerId: "operation:transform",
                  value: { path: "file", command },
                  context: { scopeId: scope.id, sessionId: session.id, directory: tmp.path, actor: { type: "ui" } },
                  pluginDir: path.dirname(entryPath),
                  manifest,
                }),
              ).toEqual({ before: "before", after: "before:shell:plugin", exitCode: 0 })
              expect(await Environment.uses(environment.id)).toHaveLength(0)
              await Environment.deallocate(environment.id, { scopeID: scope.id })
              expect(Buffer.from(await WorkspaceContent.read(selection, "file")).toString()).toBe("before:shell:plugin")
              expect(await Bun.file(path.join(tmp.path, "file")).text()).toBe("controller")
            } finally {
              await manager.stop(manifest.id)
              const current = await Environment.get(environment.id, scope.id)
              if (docker && current.allocation) await docker.deallocate(Environment.requestOf(current))
            }
          },
        })
      })
    },
    30000,
  )

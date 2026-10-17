import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { HostConnection } from "@ericsanchezok/synergy-harness/host/connection"
import { createApprovalRecord, saveApproval, removeApproval } from "../../src/plugin/consent/approval-store"
import { getPlugin, reloadDevelopmentGeneration, resetAllPluginState } from "../../src/plugin/loader"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const manifest = (generation: string, capabilities: string[] = []) =>
  compilePluginManifest(
    definePlugin({
      id: "dev-approved-ui",
      version: "1.0.0",
      description: "Development approval",
      capabilities: capabilities.map((id) => capability(id)),
      contributions: [],
    }),
    { generation },
  )

test("development reload rejects broader grants and keeps the currently approved generation", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const initial = manifest("first")
    await Bun.write(path.join(first.path, "plugin.json"), JSON.stringify(initial))
    await Bun.write(path.join(second.path, "plugin.json"), JSON.stringify(manifest("second", ["ui.commands"])))
    await using workspace = await tmpdir({ git: true, config: { plugin: [pathToFileURL(first.path).href] } })
    await saveApproval(createApprovalRecord({ pluginId: initial.id, source: "local", manifest: initial }))
    try {
      await ScopeContext.provide({
        scope: await workspace.scope(),
        fn: async () => {
          await resetAllPluginState()
          expect((await getPlugin(initial.id))?.manifest.artifacts.generation).toBe("first")
          await HostConnection.configure(initial.id, { enabled: true, name: "Fixture" })
          await expect(
            reloadDevelopmentGeneration({ pluginId: initial.id, generation: "second", artifactDir: second.path }),
          ).rejects.toThrow("approval")
          expect((await getPlugin(initial.id))?.manifest.artifacts.generation).toBe("first")
          expect((await HostConnection.describe()).name).toBe("Fixture")
        },
      })
    } finally {
      await resetAllPluginState()
      await removeApproval(initial.id)
    }
  }))

test("approved generation replacement withdraws gateway authority", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const initial = manifest("gateway-first", ["host.connection.manage"])
    await Bun.write(path.join(first.path, "plugin.json"), JSON.stringify(initial))
    const replacement = manifest("gateway-second")
    await Bun.write(path.join(second.path, "plugin.json"), JSON.stringify(replacement))
    await using workspace = await tmpdir({ git: true, config: { plugin: [pathToFileURL(first.path).href] } })
    await saveApproval(createApprovalRecord({ pluginId: initial.id, source: "local", manifest: initial }))
    try {
      await ScopeContext.provide({
        scope: await workspace.scope(),
        fn: async () => {
          await getPlugin(initial.id)
          await HostConnection.configure(initial.id, { enabled: true, name: "Fixture" })
          let closed = 0
          const unwatch = HostConnection.watch("peer", () => closed++)
          try {
            await saveApproval(
              createApprovalRecord({ pluginId: replacement.id, source: "local", manifest: replacement }),
            )
            await reloadDevelopmentGeneration({
              pluginId: initial.id,
              generation: "gateway-second",
              artifactDir: second.path,
            })
            await expect(HostConnection.describe()).rejects.toThrow("disabled")
            expect(closed).toBe(1)
          } finally {
            unwatch()
          }
        },
      })
    } finally {
      await resetAllPluginState()
      await removeApproval(initial.id)
    }
  }))

afterRuntimeTests(() => runtime.close())

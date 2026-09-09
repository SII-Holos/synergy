import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { createApprovalRecord, saveApproval, removeApproval } from "../../src/plugin/consent/approval-store"
import { getPlugin, reloadDevelopmentGeneration, resetAllPluginState } from "../../src/plugin/loader"

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

test("development reload rejects broader grants and keeps the currently approved generation", async () => {
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
        await expect(
          reloadDevelopmentGeneration({ pluginId: initial.id, generation: "second", artifactDir: second.path }),
        ).rejects.toThrow("approval")
        expect((await getPlugin(initial.id))?.manifest.artifacts.generation).toBe("first")
      },
    })
  } finally {
    await resetAllPluginState()
    await removeApproval(initial.id)
  }
})

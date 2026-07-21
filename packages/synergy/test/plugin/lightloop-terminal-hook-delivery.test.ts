import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { computeManifestHash, computePermissionsHash, saveApproval } from "../../src/plugin/consent/approval-store"
import { resetAllPluginState } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { ScopeContext } from "../../src/scope/context"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

async function writeNoHookPlugin(root: string) {
  const pluginDir = path.join(root, "no-terminal-hook-plugin")
  await fs.mkdir(pluginDir, { recursive: true })
  const manifest = {
    manifestVersion: 1,
    apiVersion: "3.0",
    id: "no-terminal-hook-plugin",
    name: "no-terminal-hook-plugin",
    version: "1.0.0",
    description: "Plugin without a terminal hook",
    capabilities: [],
    contributions: [],
    artifacts: { generation: "no-hook-generation" },
  } satisfies PluginManifestType
  await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
  return { pluginDir, manifest }
}

async function approve(manifest: PluginManifestType) {
  await saveApproval({
    pluginId: manifest.id,
    source: "local",
    version: manifest.version,
    manifestHash: computeManifestHash(manifest),
    capabilitiesHash: computePermissionsHash(manifest),
    approvedAt: Date.now(),
    approvedBy: "user",
    trustTier: "declarative",
    approvedCapabilities: [],
    risk: "low",
    status: "approved",
  })
}

async function writeHookPlugin(root: string) {
  const pluginDir = path.join(root, "terminal-hook-plugin")
  const runtimeDir = path.join(pluginDir, "runtime")
  const runtimePath = path.join(runtimeDir, "index.js")
  const resultPath = path.join(pluginDir, "hook-result.json")
  const failPath = path.join(pluginDir, "fail-hook")
  await fs.mkdir(runtimeDir, { recursive: true })
  await Bun.write(
    runtimePath,
    `
export default {
  id: "terminal-hook-plugin",
  version: "1.0.0",
  description: "LightLoop terminal hook fixture",
  assets: [],
  capabilities: [],
  handlerIds: ["hook:on-finish"],
  contributions: [{
    kind: "hook",
    id: "on-finish",
    point: "lightloop.after",
    priority: 0,
    async handler(input, context) {
      if (await Bun.file(${JSON.stringify(failPath)}).exists()) throw new Error("plugin state write failed")
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        input,
        sessionId: context.sessionId,
        pluginGeneration: context.runtime.pluginGeneration,
      }))
    },
  }],
}
`,
  )
  const manifest = {
    manifestVersion: 1,
    apiVersion: "3.0",
    id: "terminal-hook-plugin",
    name: "terminal-hook-plugin",
    version: "1.0.0",
    description: "LightLoop terminal hook fixture",
    capabilities: [],
    contributions: [{ kind: "hook", id: "on-finish", point: "lightloop.after", priority: 0 }],
    artifacts: {
      generation: "owner-generation",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    },
  } satisfies PluginManifestType
  await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
  return { pluginDir, manifest, resultPath, failPath }
}

describe.serial("plugin-owned LightLoop terminal hook delivery", () => {
  test("acknowledges only matching successful handlers and forwards execution identity", async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = await writeHookPlugin(tmp.path)
    const noHook = await writeNoHookPlugin(tmp.path)
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await approve(fixture.manifest)
        await approve(noHook.manifest)
        await Config.update({
          plugin: [pathToFileURL(fixture.pluginDir).href, pathToFileURL(noHook.pluginDir).href],
        } as Config.Info)
        await resetAllPluginState()

        try {
          const mismatch = await Plugin.deliverHookForPlugin(
            fixture.manifest.id,
            "stale-generation",
            "lightloop.after",
            { loop: { sessionID: "ses_execution", status: "completed", instructions: "Finish" } },
          )
          expect(mismatch).toEqual({
            status: "plugin_mismatch",
            handlerCount: 0,
            error: "Plugin terminal-hook-plugin generation stale-generation is not active",
          })
          expect(await Bun.file(fixture.resultPath).exists()).toBe(false)

          const missingHandler = await Plugin.deliverHookForPlugin(
            noHook.manifest.id,
            noHook.manifest.artifacts.generation,
            "lightloop.after",
            { loop: { sessionID: "ses_execution", status: "completed", instructions: "Finish" } },
          )
          expect(missingHandler).toEqual({
            status: "no_handler",
            handlerCount: 0,
            error: "Plugin no-terminal-hook-plugin has no handler for lightloop.after",
          })

          await Bun.write(fixture.failPath, "fail")
          const failed = await Plugin.deliverHookForPlugin(
            fixture.manifest.id,
            fixture.manifest.artifacts.generation,
            "lightloop.after",
            { loop: { sessionID: "ses_execution", status: "completed", instructions: "Finish" } },
          )
          expect(failed).toMatchObject({
            status: "failed",
            handlerCount: 1,
            succeededHandlerCount: 0,
          })
          if (failed.status === "failed") expect(failed.error).toContain("plugin state write failed")
          expect(await Bun.file(fixture.resultPath).exists()).toBe(false)

          await fs.rm(fixture.failPath)
          const delivered = await Plugin.deliverHookForPlugin(
            fixture.manifest.id,
            fixture.manifest.artifacts.generation,
            "lightloop.after",
            { loop: { sessionID: "ses_execution", status: "completed", instructions: "Finish" } },
          )
          expect(delivered).toEqual({ status: "delivered", handlerCount: 1 })
          expect(await Bun.file(fixture.resultPath).json()).toEqual({
            input: { loop: { sessionID: "ses_execution", status: "completed", instructions: "Finish" } },
            sessionId: "ses_execution",
            pluginGeneration: "owner-generation",
          })
        } finally {
          await pluginRuntimeManager.stop(fixture.manifest.id, 0)
          await resetAllPluginState()
        }
      },
    })
  }, 15_000)
})

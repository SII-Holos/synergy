import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { createApprovalRecord, saveApproval } from "../../src/plugin/consent/approval-store"
import { getCatalogPlugin, resetAllPluginState } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { ScopeContext } from "../../src/scope/context"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

async function writeTimeoutHookPlugin(root: string) {
  const pluginDir = path.join(root, "hook-timeout-config-plugin")
  const runtimeDir = path.join(pluginDir, "runtime")
  const runtimePath = path.join(runtimeDir, "index.js")
  const startedPath = path.join(pluginDir, "hook-started")
  const completedPath = path.join(pluginDir, "hook-completed")
  await fs.mkdir(runtimeDir, { recursive: true })
  await Bun.write(
    runtimePath,
    `
export default {
  id: "hook-timeout-config-plugin",
  version: "1.0.0",
  description: "Hook timeout config process fixture",
  assets: [],
  capabilities: [],
  handlerIds: ["hook:first"],
  contributions: [
    {
      kind: "hook",
      id: "first",
      point: "tool.execute.before",
      priority: 0,
      async handler(input, context) {
        await Bun.write(${JSON.stringify(startedPath)}, "started")
        await new Promise((resolve, reject) => {
          const timer = setTimeout(async () => {
            await Bun.write(${JSON.stringify(completedPath)}, "completed")
            resolve(input)
          }, 2_000)
          context.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(context.signal.reason)
            },
            { once: true },
          )
        })
        return input
      },
    },
  ],
}
`,
  )
  const manifest = {
    manifestVersion: 1,
    apiVersion: "4.0",
    compatibility: { synergy: ">=3.0.11" },
    id: "hook-timeout-config-plugin",
    name: "hook-timeout-config-plugin",
    version: "1.0.0",
    description: "Hook timeout config process fixture",
    capabilities: [],
    contributions: [{ kind: "hook", id: "first", point: "tool.execute.before", priority: 0 }],
    artifacts: {
      generation: "hook-timeout-config-generation",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    },
  } satisfies PluginManifestType
  await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
  return { pluginDir, manifest, startedPath, completedPath }
}

async function approve(manifest: PluginManifestType) {
  await saveApproval(
    createApprovalRecord({
      pluginId: manifest.id,
      source: "local",
      manifest,
    }),
  )
}

async function waitForFile(filePath: string, timeoutMs = 5_000) {
  await Promise.race([
    (async () => {
      while (!(await Bun.file(filePath).exists())) await Bun.sleep(10)
    })(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${path.basename(filePath)}`)
    }),
  ])
}

describe.serial("process plugin hook timeout config", () => {
  test("hookTimeoutMs config caps a hook handler that exceeds it", async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = await writeTimeoutHookPlugin(tmp.path)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await approve(fixture.manifest)
        await Config.state.reset()
        await Config.update({
          plugin: [pathToFileURL(fixture.pluginDir).href],
          pluginRuntimePolicy: { limits: { hookTimeoutMs: 300 } },
        } as Config.Info)
        await Config.state.reset()
        expect((await Config.current()).pluginRuntimePolicy?.limits?.hookTimeoutMs).toBe(300)
        await resetAllPluginState()

        try {
          const triggered = Plugin.trigger(
            "tool.execute.before",
            { tool: "file_search", sessionID: "ses_hook_timeout", callID: "call_hook_timeout" },
            { args: { query: "evidence" } },
          )
          await waitForFile(fixture.startedPath)
          // tool.execute.before is a transform with failure "continue": the
          // timed-out handler is recorded as degraded and the hook resolves.
          await expect(triggered).resolves.toEqual({ args: { query: "evidence" } })
          expect(await Bun.file(fixture.completedPath).exists()).toBe(false)
          const plugin = getCatalogPlugin(fixture.manifest.id)
          expect(plugin?.contributionHealth.get("hook:first")).toMatchObject({ state: "degraded" })
        } finally {
          await pluginRuntimeManager.stop(fixture.manifest.id, 0)
          await resetAllPluginState()
        }
      },
    })
  }, 15_000)
})

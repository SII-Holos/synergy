import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { createApprovalRecord, saveApproval } from "../../src/plugin/consent/approval-store"
import { resetAllPluginState } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { ScopeContext } from "../../src/scope/context"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

async function writeToolHookPlugin(root: string) {
  const pluginDir = path.join(root, "tool-hook-abort-plugin")
  const runtimeDir = path.join(pluginDir, "runtime")
  const runtimePath = path.join(runtimeDir, "index.js")
  const startedPath = path.join(pluginDir, "first-started")
  const abortedPath = path.join(pluginDir, "first-aborted")
  const secondPath = path.join(pluginDir, "second-started")
  await fs.mkdir(runtimeDir, { recursive: true })
  await Bun.write(
    runtimePath,
    `
export default {
  id: "tool-hook-abort-plugin",
  version: "1.0.0",
  description: "Tool hook abort process fixture",
  assets: [],
  capabilities: [],
  handlerIds: ["hook:first", "hook:second"],
  contributions: [
    {
      kind: "hook",
      id: "first",
      point: "tool.execute.before",
      priority: 0,
      async handler(input, context) {
        await Bun.write(${JSON.stringify(startedPath)}, "started")
        await new Promise((resolve, reject) => {
          const abort = async () => {
            await Bun.write(${JSON.stringify(abortedPath)}, "aborted")
            reject(context.signal.reason)
          }
          if (context.signal.aborted) void abort()
          else context.signal.addEventListener("abort", () => void abort(), { once: true })
        })
        return input
      },
    },
    {
      kind: "hook",
      id: "second",
      point: "tool.execute.before",
      priority: 1,
      async handler(input) {
        await Bun.write(${JSON.stringify(secondPath)}, "started")
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
    id: "tool-hook-abort-plugin",
    name: "tool-hook-abort-plugin",
    version: "1.0.0",
    description: "Tool hook abort process fixture",
    capabilities: [],
    contributions: [
      { kind: "hook", id: "first", point: "tool.execute.before", priority: 0 },
      { kind: "hook", id: "second", point: "tool.execute.before", priority: 1 },
    ],
    artifacts: {
      generation: "tool-hook-abort-generation",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    },
  } satisfies PluginManifestType
  await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
  return { pluginDir, manifest, startedPath, abortedPath, secondPath }
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

async function waitForFile(filePath: string) {
  await Promise.race([
    (async () => {
      while (!(await Bun.file(filePath).exists())) await Bun.sleep(10)
    })(),
    Bun.sleep(2_000).then(() => {
      throw new Error(`Timed out waiting for ${path.basename(filePath)}`)
    }),
  ])
}

describe.serial("process plugin tool hook cancellation", () => {
  test("propagates abort into the active handler and skips later handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = await writeToolHookPlugin(tmp.path)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await approve(fixture.manifest)
        await Config.update({ plugin: [pathToFileURL(fixture.pluginDir).href] } as Config.Info)
        await resetAllPluginState()
        const controller = new AbortController()

        try {
          const triggered = Plugin.trigger(
            "tool.execute.before",
            { tool: "file_search", sessionID: "ses_hook_abort", callID: "call_hook_abort" },
            { args: { query: "evidence" } },
            { signal: controller.signal },
          )
          await waitForFile(fixture.startedPath)
          controller.abort(new DOMException("Tool execution timed out", "TimeoutError"))

          await expect(triggered).rejects.toThrow("Tool execution timed out")
          await waitForFile(fixture.abortedPath)
          expect(await Bun.file(fixture.secondPath).exists()).toBe(false)
        } finally {
          controller.abort()
          await pluginRuntimeManager.stop(fixture.manifest.id, 0)
          await resetAllPluginState()
        }
      },
    })
  }, 15_000)
})

import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { createApprovalRecord, saveApproval } from "@ericsanchezok/synergy-plugin-host/plugin/consent/approval-store"
import { resetAllPluginState } from "@ericsanchezok/synergy-plugin-host/plugin/loader"
import { pluginRuntimeManager } from "@ericsanchezok/synergy-plugin-host/plugin/runtime"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { LLM } from "@ericsanchezok/synergy-harness/test/internal/session/llm"
import { PromptBudgeter } from "@ericsanchezok/synergy-harness/test/internal/session/prompt-budgeter"
import { sha256File } from "@ericsanchezok/synergy-harness/util/crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import "@ericsanchezok/synergy-product-runtime/product-registration"

function model(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test-provider",
    name: "Test Model",
    limit: { context: 100_000, output: 8_192 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai", id: "gpt-5" },
    options: {},
  } as Provider.Model
}

async function writeTransformPlugin(root: string) {
  const pluginDir = path.join(root, "system-transform-plugin")
  const runtimeDir = path.join(pluginDir, "runtime")
  const runtimePath = path.join(runtimeDir, "index.js")
  const inputPath = path.join(pluginDir, "transform-input.json")
  await fs.mkdir(runtimeDir, { recursive: true })
  await Bun.write(
    runtimePath,
    `
export default {
  id: "system-transform-plugin",
  version: "1.0.0",
  description: "System transform process fixture",
  assets: [],
  capabilities: [],
  handlerIds: ["hook:transform-system"],
  contributions: [{
    kind: "hook",
    id: "transform-system",
    point: "experimental.chat.system.transform",
    priority: 0,
    async handler(input) {
      await Bun.write(${JSON.stringify(inputPath)}, JSON.stringify(input))
      return { system: [...input.system, "plugin marker"] }
    },
  }],
}
`,
  )
  const manifest = {
    manifestVersion: 1,
    apiVersion: "4.0",
    compatibility: { synergy: ">=3.0.11" },
    id: "system-transform-plugin",
    name: "system-transform-plugin",
    version: "1.0.0",
    description: "System transform process fixture",
    capabilities: [],
    contributions: [
      {
        kind: "hook",
        id: "transform-system",
        point: "experimental.chat.system.transform",
        priority: 0,
      },
    ],
    artifacts: {
      generation: "system-transform-generation",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    },
  } satisfies PluginManifestType
  await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
  return { pluginDir, inputPath, manifest }
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

describe.serial("process plugin system transform hook", () => {
  test("receives complete budget metadata and applies the returned system", async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = await writeTransformPlugin(tmp.path)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await approve(fixture.manifest)
        await Config.update({ plugin: [pathToFileURL(fixture.pluginDir).href] } as Config.Info)
        await resetAllPluginState()

        try {
          const plan = await PromptBudgeter.buildPlan({
            sessionID: "ses_transform",
            agent: "synergy",
            messageID: "msg_transform",
            model: model(),
            system: ["base system"],
            messages: [],
            toolDefinitions: [],
          })

          expect(plan.system).toEqual(["base system", "plugin marker"])
          expect(await Bun.file(fixture.inputPath).json()).toEqual({
            phase: "budget",
            sessionID: "ses_transform",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            messageID: "msg_transform",
            system: ["base system"],
          })
        } finally {
          await pluginRuntimeManager.stop(fixture.manifest.id, 0)
          await resetAllPluginState()
        }
      },
    })
  }, 15_000)

  test("prepares final plugin hooks before an Agent turn crosses the worker boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = await writeTransformPlugin(tmp.path)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await approve(fixture.manifest)
        await Config.update({ plugin: [pathToFileURL(fixture.pluginDir).href] } as Config.Info)
        await resetAllPluginState()

        try {
          const prepared = await LLM.prepare({
            user: { id: "msg_final" },
            sessionID: "ses_final",
            model: model(),
            agent: { name: "synergy", prompt: "agent prompt" },
            system: ["base system"],
            messages: [],
            abort: new AbortController().signal,
            tools: {},
          } as unknown as LLM.StreamInput)

          expect(prepared.system.at(-1)).toBe("plugin marker")
          expect(prepared.params.options).toBeDefined()
          expect(await Bun.file(fixture.inputPath).json()).toMatchObject({
            phase: "final",
            sessionID: "ses_final",
            messageID: "msg_final",
          })
        } finally {
          await pluginRuntimeManager.stop(fixture.manifest.id, 0)
          await resetAllPluginState()
        }
      },
    })
  }, 15_000)
})

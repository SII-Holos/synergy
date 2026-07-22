import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { Provider } from "../../src/provider/provider"
import { Config } from "../../src/config/config"
import { computeManifestHash, computePermissionsHash, saveApproval } from "../../src/plugin/consent/approval-store"
import { resetAllPluginState } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { ScopeContext } from "../../src/scope/context"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { sha256File } from "../../src/util/crypto"
import { tmpdir } from "../fixture/fixture"

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
    apiVersion: "3.0",
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
})

import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { LLM } from "../../src/session/llm"
import { Plugin } from "../../src/plugin"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"

const originalGlobal = Config.global
const originalTrigger = Plugin.trigger
const originalGetLanguage = Provider.getLanguage

function createModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test-provider",
    name: "Test Model",
    limit: { context: 100_000, output: 8_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { npm: "@ai-sdk/openai", id: "gpt-test", url: "https://example.com" },
    options: {},
  } as Provider.Model
}

afterEach(() => {
  ;(Config as any).global = originalGlobal
  ;(Plugin as any).trigger = originalTrigger
  ;(Provider as any).getLanguage = originalGetLanguage
})

async function writeSystemTransformPlugin(
  root: string,
  input: {
    id: string
    promptTransform?: boolean
    hookBody: string
  },
) {
  const dir = path.join(root, input.id)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: input.id,
        version: "0.1.0",
        main: "./src/index.ts",
        description: "System transform test plugin",
        runtime: { mode: "in-process" },
        permissions: { hooks: { promptTransform: input.promptTransform } },
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "src", "index.ts"),
    `export default {
  id: ${JSON.stringify(input.id)},
  async init() {
    return {
      "experimental.chat.system.transform": async (input, output) => {
        ${input.hookBody}
      }
    }
  }
}
`,
  )
  return dir
}

describe("plugin system transform hooks", () => {
  test("requires promptTransform permission", async () => {
    await using tmp = await tmpdir({ git: true })
    const denied = await writeSystemTransformPlugin(tmp.path, {
      id: "system-transform-denied",
      hookBody: `output.system.push("denied")`,
    })
    const allowed = await writeSystemTransformPlugin(tmp.path, {
      id: "system-transform-allowed",
      promptTransform: true,
      hookBody: `output.system.push("allowed")`,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(denied).href, pathToFileURL(allowed).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const output = { system: ["base"] }
        await Plugin.trigger(
          "experimental.chat.system.transform",
          {
            phase: "final",
            sessionID: "session-1",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            messageID: "message-1",
          },
          output,
        )
        expect(output.system).toEqual(["base", "allowed"])
      },
    })
  })

  test("budget phase receives context and restores emptied system prompt", async () => {
    const calls: unknown[] = []
    ;(Plugin as any).trigger = mock(async (_name: string, input: unknown, output: { system: string[] }) => {
      calls.push(input)
      output.system.length = 0
      return output
    })

    const plan = await PromptBudgeter.buildPlan({
      sessionID: "session-1",
      agent: "synergy-max",
      messageID: "message-1",
      model: createModel(),
      system: ["base system"],
      messages: [{ role: "user", content: "hello" }],
      toolDefinitions: [],
    })

    expect(calls).toEqual([
      {
        phase: "budget",
        sessionID: "session-1",
        agent: "synergy-max",
        model: { providerID: "test-provider", modelID: "test-model" },
        messageID: "message-1",
      },
    ])
    expect(plan.system).toEqual(["base system"])
  })

  test("final phase receives context so plugins can avoid duplicate injection", async () => {
    const finalContext: unknown[] = []
    const stop = new Error("stop after final transform")
    ;(Provider as any).getLanguage = mock(async () => ({}) as any)
    ;(Config as any).global = mock(async () => ({ role_variant: {}, provider: {} }))
    ;(Plugin as any).trigger = mock(async (name: string, input: unknown, output: { system?: string[] }) => {
      if (name === "experimental.chat.system.transform") {
        finalContext.push(input)
        output.system?.push("final-only")
        throw stop
      }
      return output
    })

    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          LLM.stream({
            user: {
              id: "message-2",
              role: "user",
              time: { created: Date.now() },
              parts: [{ type: "text", text: "hi" }],
            } as any,
            sessionID: "session-2",
            model: createModel(),
            agent: { name: "synergy", prompt: "agent prompt", options: {} } as Agent.Info,
            system: ["runtime system"],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "hello" }],
            small: true,
            tools: {},
          }),
        ).rejects.toBe(stop)
      },
    })

    expect(finalContext).toEqual([
      {
        phase: "final",
        sessionID: "session-2",
        agent: "synergy",
        model: { providerID: "test-provider", modelID: "test-model" },
        messageID: "message-2",
        small: true,
      },
    ])
  })
})

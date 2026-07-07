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
import { defaultRuntimeRegistry } from "../../src/plugin-runtime/registry"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
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

function createModelWith(input: Partial<Provider.Model>): Provider.Model {
  return {
    ...createModel(),
    ...input,
    api: {
      ...createModel().api,
      ...input.api,
    },
  } as Provider.Model
}

function commonSerializedPrefixLength(a: unknown[], b: unknown[]) {
  const left = JSON.stringify(a)
  const right = JSON.stringify(b)
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index++
  return index
}

function serializedLength(value: unknown[]) {
  return JSON.stringify(value).length
}

describe("LLM.promptMessages", () => {
  test("renders late advisory context after history for OpenAI-compatible cache layout", () => {
    const messages = LLM.promptMessages({
      model: createModel(),
      system: ["agent prompt", "permission context"],
      lateSystem: ["memory changes", "volatile time"],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    })

    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "user"])
    expect(messages[0]).toEqual({ role: "system", content: "agent prompt" })
    expect(messages[1]).toEqual({ role: "system", content: "permission context" })
    expect(messages[2]).toEqual({ role: "user", content: "first" })
    expect(messages[3]).toEqual({ role: "assistant", content: "second" })
    expect(String(messages[4].content)).toContain("<runtime-context>")
    expect(String(messages[4].content)).toContain("memory changes")
    expect(String(messages[4].content)).toContain("volatile time")
  })

  test("preserves reusable OpenAI history prefix when late advisory context changes across turns", () => {
    const stableSystem = ["agent prompt", "project instructions", "permission context"]
    const history = [
      { role: "user", content: "first request" },
      { role: "assistant", content: "first answer" },
    ] as const
    const first = LLM.promptMessages({
      model: createModel(),
      system: stableSystem,
      lateSystem: ["memory A", "time A"],
      messages: [...history],
    })
    const second = LLM.promptMessages({
      model: createModel(),
      system: stableSystem,
      lateSystem: ["memory B", "time B"],
      messages: [...history],
    })
    const stablePrefix = [...stableSystem.map((content) => ({ role: "system", content })), ...history]

    expect(commonSerializedPrefixLength(first, second)).toBeGreaterThanOrEqual(serializedLength(stablePrefix) - 1)
    expect(first.at(-1)?.role).toBe("user")
    expect(String(first.at(-1)?.content)).toContain("memory A")
    expect(String(second.at(-1)?.content)).toContain("memory B")
  })

  test("keeps tool-call history before late advisory context for OpenAI-compatible layouts", () => {
    const messages = LLM.promptMessages({
      model: createModel(),
      system: ["agent prompt", "permission context"],
      lateSystem: ["memory changed", "time changed"],
      messages: [
        { role: "user", content: "run a command" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: "C:/repo" }],
        },
      ] as any,
    })

    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "tool", "user"])
    expect(messages[3].role).toBe("assistant")
    expect(messages[4].role).toBe("tool")
    expect(String(messages[5].content)).toContain("<runtime-context>")
  })

  test("keeps late advisory context as system messages for Anthropic cache breakpoints", () => {
    const messages = LLM.promptMessages({
      model: createModelWith({ providerID: "anthropic", api: { npm: "@ai-sdk/anthropic", id: "claude-test" } } as any),
      system: ["agent prompt", "permission context"],
      lateSystem: ["memory changes"],
      messages: [{ role: "user", content: "hello" }],
    })

    expect(messages).toEqual([
      { role: "system", content: "agent prompt" },
      { role: "system", content: "permission context" },
      { role: "system", content: "memory changes" },
      { role: "user", content: "hello" },
    ])
  })

  test("uses legacy ordering for unknown provider layouts", () => {
    const messages = LLM.promptMessages({
      model: createModelWith({ providerID: "custom", api: { npm: "custom-sdk", id: "custom-model" } } as any),
      system: ["agent prompt"],
      lateSystem: ["memory changes"],
      messages: [{ role: "user", content: "hello" }],
    })

    expect(messages).toEqual([
      { role: "system", content: "agent prompt" },
      { role: "system", content: "memory changes" },
      { role: "user", content: "hello" },
    ])
  })
})

afterEach(() => {
  ;(Config as any).global = originalGlobal
  ;(Plugin as any).trigger = originalTrigger
  ;(Provider as any).getLanguage = originalGetLanguage
  defaultRuntimeRegistry.clear()
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

  test("process runtime system transform hook writes returned system output", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await writeSystemTransformPlugin(tmp.path, {
      id: "process-system-transform",
      promptTransform: true,
      hookBody: `output.system.push("unused local hook")`,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(dir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: false, highRiskRequiresProcess: true },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const loaded = await Plugin.getLoaded()
        const plugin = loaded.find((item) => item.id === "process-system-transform")
        expect(plugin?.runtimeMode).toBe("process")

        defaultRuntimeRegistry.set({
          pluginId: "process-system-transform",
          mode: "process",
          state: "ready",
          restarts: 0,
          warnings: [],
          limits: DEFAULT_LIMITS,
          hooks: ["experimental.chat.system.transform"],
          request: mock(async (message: any) => {
            expect(message.type).toBe("triggerHook")
            expect(message.hook).toBe("experimental.chat.system.transform")
            return { system: [...message.output.system, "runtime-added"] }
          }),
        } as any)

        const output = { system: ["base"] }
        const systemRef = output.system
        await Plugin.trigger(
          "experimental.chat.system.transform",
          {
            phase: "final",
            sessionID: "session-runtime",
            agent: "synergy-max",
            model: { providerID: "test-provider", modelID: "test-model" },
            messageID: "message-runtime",
          },
          output,
        )

        expect(output.system).toBe(systemRef)
        expect(systemRef).toEqual(["base", "runtime-added"])
      },
    })
  })
})

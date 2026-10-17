import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { z } from "zod"
import { Cortex } from "../../src/cortex"
import { Identifier } from "../../src/id/id"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionContextContributions } from "../../src/session/context-contributions"
import { createUserMessage } from "../../src/session/input"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { ToolRegistry } from "../../src/tool/registry"
import { SessionPluginHooks } from "../../src/session/plugin-hooks"
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

const TEST_TIMEOUT_MS = 20_000

for (const backend of storageTestBackends()) {
  for (const codex of [false, true]) {
    for (const mode of [
      "tool",
      "tool-compaction",
      "initial-compaction",
      "manual-compaction",
      "overflow-compaction",
      "compaction-hook-failure",
      "queued-task",
      "empty-context",
      "queued-empty-context",
      "cancel-context",
    ] as const) {
      test(
        `${backend}: ${codex ? "codex" : "compatible"} ${mode} retains task context at the model boundary`,
        async () => {
          const deadline = performance.now() + TEST_TIMEOUT_MS
          const prompts: string[] = []
          const collected: boolean[] = []
          type Request = Pick<Parameters<LanguageModelV2["doStream"]>[0], "prompt" | "tools" | "toolChoice">
          const compactionRequests: Request[] = []
          const conversationRequests: Request[] = []
          const committed: string[] = []
          let finalPreparations = 0
          let parameterPreparations = 0
          const collectionStarted = Promise.withResolvers<void>()
          const releaseCollection = Promise.withResolvers<void>()
          let collectionSignal: AbortSignal | undefined
          const queued = mode === "queued-task" || mode === "queued-empty-context"
          let compactions = 0
          let calls = 0
          const stream = (chunks: LanguageModelV2StreamPart[]) => ({
            stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
          })
          const text = (value: string): LanguageModelV2StreamPart[] => [
            { type: "text-start", id: "reply" },
            { type: "text-delta", id: "reply", delta: value },
            { type: "text-end", id: "reply" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } },
          ]
          const models: Record<string, LanguageModelV2> = {
            approved: {
              specificationVersion: "v2",
              provider: "fixture",
              supportedUrls: {},
              modelId: "approved",
              doGenerate: async () => {
                throw new Error("Unexpected non-streaming call")
              },
              doStream: async (input) => {
                if (JSON.stringify(input.prompt).includes("Write the compaction continuation summary now.")) {
                  compactions++
                  compactionRequests.push(
                    JSON.parse(
                      JSON.stringify({ prompt: input.prompt, tools: input.tools, toolChoice: input.toolChoice }),
                    ),
                  )
                  return stream(text("Summary deliberately omitting fixture context."))
                }
                conversationRequests.push(
                  JSON.parse(
                    JSON.stringify({ prompt: input.prompt, tools: input.tools, toolChoice: input.toolChoice }),
                  ),
                )
                prompts.push(JSON.stringify(input.prompt))
                if (mode === "overflow-compaction") {
                  if (calls++ === 0) throw new Error("context_length_exceeded")
                  return stream(text("Completed."))
                }
                const tool = mode !== "initial-compaction" && calls++ % 2 === 0
                return stream(
                  tool
                    ? [
                        {
                          type: "tool-call",
                          toolCallId: `fixture-call-${calls}`,
                          toolName: "fixture_step",
                          input: "{}",
                        },
                        {
                          type: "finish",
                          finishReason: "tool-calls",
                          usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
                        },
                      ]
                    : text("Completed."),
                )
              },
            },
            compact: {
              specificationVersion: "v2",
              provider: "fixture",
              supportedUrls: {},
              modelId: "compact",
              doGenerate: async () => {
                throw new Error("Unexpected non-streaming call")
              },
              doStream: async () => {
                compactions++
                return stream(text("Summary deliberately omitting fixture context."))
              },
            },
            auxiliary: {
              specificationVersion: "v2",
              provider: "fixture",
              supportedUrls: {},
              modelId: "auxiliary",
              doGenerate: async () => {
                throw new Error("Unexpected non-streaming call")
              },
              doStream: async () => stream(text("Fixture title.")),
            },
          }
          const sdk: ProviderV2 & { responses(id: string): LanguageModelV2 } = {
            responses(id) {
              return this.languageModel(id) as LanguageModelV2
            },
            languageModel(id) {
              const model = models[id]
              if (!model) throw new Error("Unexpected fixture model")
              return model
            },
            textEmbeddingModel() {
              throw new Error("Unexpected embedding call")
            },
            imageModel() {
              throw new Error("Unexpected image call")
            },
          }
          const model = {
            name: "Fixture",
            release_date: "2026-10-01",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            limit: { context: 128000, output: 8000 },
            options: {},
          }
          const config = {
            model: "fixture/approved",
            nano_model: "fixture/auxiliary",
            mini_model: "fixture/auxiliary",
            long_context_model: "fixture/compact",
            provider: {
              fixture: {
                ...(codex ? { profile: "openai-codex" } : {}),
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "synthetic-fixture-key", baseURL: "https://fixture.invalid/v1" },
                models: {
                  approved: { ...model, id: "approved" },
                  compact: { ...model, id: "compact" },
                  auxiliary: { ...model, id: "auxiliary" },
                },
              },
            },
            agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
          }
          await using runtime = await testRuntime({
            postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined,
            env: { SYNERGY_CONFIG_CONTENT: JSON.stringify(config) },
            register() {
              ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
              SessionContextContributions.register("fixture-context", {
                async contribute(input): Promise<SessionContextContributions.Result | undefined> {
                  collected.push(input.isTopSession)
                  if (mode === "empty-context" || (mode === "queued-empty-context" && collected.length === 2)) return
                  if (mode === "cancel-context" && collected.length === 1) {
                    collectionSignal = input.signal
                    collectionStarted.resolve()
                    await releaseCollection.promise
                    return { context: "<cancelled-context>Discard this result.</cancelled-context>", injection: {} }
                  }
                  return {
                    context: `<fixture-context>${input.isTopSession ? "root" : "child"} memory ${collected.length}</fixture-context>`,
                    injection: { fixture: "synthetic-memory" },
                  }
                },
                committed(sessionID) {
                  committed.push(sessionID)
                },
              })
              const step = Tool.define(
                "fixture_step",
                {
                  description: "Advance the synthetic task.",
                  parameters: z.object({}),
                  async execute(_, context) {
                    if (queued && calls === 1)
                      await SessionInbox.enqueueUser({
                        sessionID: context.sessionID,
                        agent: "fixture",
                        model: { providerID: "fixture", modelID: "approved" },
                        parts: [{ type: "text", text: "Perform the next synthetic task." }],
                      })
                    if (mode === "tool-compaction") {
                      const message = await MessageV2.get({
                        sessionID: context.sessionID,
                        messageID: context.messageID,
                      })
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        sessionID: context.sessionID,
                        messageID: message.info.rootID ?? context.messageID,
                        type: "compaction",
                        auto: true,
                      })
                    }
                    return { title: "Advanced", output: "Continue the task.", metadata: {} }
                  },
                },
                { requiresWorkspace: false },
              )
              ToolRegistry.registerToolProvider("fixture", () => [{ ...step, exposure: { mode: "resident" } }])
            },
          })
          try {
            await runtime.run(async () =>
              ScopeContext.provide({
                scope: Scope.home(),
                async fn() {
                  const session = await Session.create({ workspace: null })
                  const input = {
                    sessionID: session.id,
                    messageID: Identifier.ascending("message"),
                    agent: "fixture",
                    model: { providerID: "fixture", modelID: "approved" },
                    parts: [{ type: "text" as const, text: "Perform the synthetic task." }],
                  }
                  await createUserMessage(input)
                  if (mode === "overflow-compaction") {
                    SessionPluginHooks.registerTrigger(async (point, context, initial) => {
                      if (
                        point === "chat.system.transform" &&
                        (context as { phase?: string; agent?: string }).phase === "final" &&
                        (context as { agent?: string }).agent === "fixture"
                      ) {
                        const system = initial as { system: string[] }
                        system.system.push(`Frozen preparation ${++finalPreparations}`)
                      }
                      if (
                        point === "chat.params" &&
                        (context as { agent?: { name?: string } }).agent?.name === "fixture"
                      ) {
                        const params = initial as { temperature?: number }
                        params.temperature = ++parameterPreparations / 10
                      }
                      return initial
                    })
                  }
                  if (mode === "compaction-hook-failure") {
                    SessionPluginHooks.registerTrigger(async (point, _context, initial) => {
                      if (point === "experimental.session.compacting") throw new Error("Fixture compaction hook failed")
                      return initial
                    })
                  }
                  if (
                    mode === "initial-compaction" ||
                    mode === "manual-compaction" ||
                    mode === "compaction-hook-failure"
                  )
                    await Session.updatePart({
                      id: Identifier.ascending("part"),
                      sessionID: session.id,
                      messageID: input.messageID,
                      type: "compaction",
                      auto: mode !== "manual-compaction",
                    })
                  if (mode === "cancel-context") {
                    const pending = SessionInvoke.invoke(input).then(
                      () => undefined,
                      (error: unknown) => error,
                    )
                    try {
                      await collectionStarted.promise
                      SessionInvoke.cancel(session.id)
                      releaseCollection.resolve()
                      expect(await pending).toMatchObject({ data: { errorName: "MessageAbortedError" } })
                      expect(collectionSignal?.aborted).toBe(true)
                      expect(prompts).toHaveLength(0)
                      expect(committed).toHaveLength(0)
                      const next = { ...input, messageID: Identifier.ascending("message") }
                      await createUserMessage(next)
                      await SessionInvoke.invoke(next)
                      expect(prompts).toHaveLength(2)
                      for (const prompt of prompts) {
                        expect(prompt.includes("root memory 2")).toBe(true)
                        expect(prompt.includes("cancelled-context")).toBe(false)
                      }
                      expect(collected).toEqual([true, true])
                      expect(committed).toEqual([session.id])
                    } finally {
                      releaseCollection.resolve()
                      await pending
                    }
                    return
                  }
                  if (mode === "compaction-hook-failure") {
                    await expect(SessionInvoke.invoke(input)).rejects.toBeDefined()
                    const attempts = (await Session.messages({ sessionID: session.id })).filter(
                      (message) => message.info.role === "assistant",
                    )
                    expect(attempts).toHaveLength(1)
                    expect(attempts[0]?.info).toMatchObject({
                      mode: "compaction",
                      agent: "compaction",
                      finish: "error",
                      includeInContext: false,
                      metadata: { compactionAttempt: { state: "failed" } },
                    })
                    expect(prompts).toHaveLength(0)
                    expect(compactions).toBe(0)
                    return
                  }
                  const result = await SessionInvoke.invoke(input)
                  if (mode === "overflow-compaction") {
                    expect(prompts).toHaveLength(2)
                    expect(compactions).toBe(1)
                    expect(finalPreparations).toBe(2)
                    expect(parameterPreparations).toBe(2)
                    expect(compactionRequests[0]?.prompt.slice(0, -1)).toEqual(conversationRequests[0]?.prompt)
                    expect(compactionRequests[0]?.tools).toEqual(conversationRequests[0]?.tools)
                    expect(compactionRequests[0]?.toolChoice).toEqual({ type: "none" })
                    expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
                    return
                  }
                  if (mode === "manual-compaction") {
                    expect(prompts).toHaveLength(0)
                    expect(compactions).toBe(1)
                    expect(result.info.role === "assistant" && result.info.summary).toBe(true)
                    expect(compactionRequests[0]?.tools?.some((tool) => tool.name === "fixture_step")).toBe(true)
                    expect(JSON.stringify(compactionRequests[0]?.prompt)).toContain("root memory 1")
                    expect(compactionRequests[0]?.toolChoice).toEqual({ type: "none" })
                    return
                  }
                  const expectedCalls = mode === "initial-compaction" ? 1 : queued ? 4 : 2
                  expect(prompts).toHaveLength(expectedCalls)
                  if (mode === "empty-context") {
                    for (const prompt of prompts) expect(prompt.includes("<fixture-context>")).toBe(false)
                    expect(collected).toEqual([true])
                    expect(committed).toHaveLength(0)
                    return
                  }
                  if (queued) {
                    for (const prompt of prompts.slice(0, 2)) expect(prompt.includes("root memory 1")).toBe(true)
                    for (const prompt of prompts.slice(2)) {
                      expect(prompt.includes("root memory 1")).toBe(codex)
                      if (mode === "queued-task") expect(prompt.includes("root memory 2")).toBe(true)
                      else if (!codex) expect(prompt.includes("fixture-context")).toBe(false)
                      else expect(prompt.includes("no longer active")).toBe(true)
                    }
                    expect(collected).toEqual([true, true])
                    expect(committed).toEqual(mode === "queued-task" ? [session.id, session.id] : [session.id])
                    return
                  }
                  for (const prompt of prompts) expect(prompt.includes("root memory")).toBe(true)
                  expect(collected).toEqual([true])
                  expect(committed).toEqual([session.id])
                  if (mode === "initial-compaction") {
                    expect(compactionRequests[0]?.toolChoice).toEqual({ type: "none" })
                    expect(compactionRequests[0]?.tools).toEqual(conversationRequests[0]?.tools)
                    expect(compactionRequests[0]?.prompt.filter((message) => message.role === "system")).toEqual(
                      conversationRequests[0]?.prompt.filter((message) => message.role === "system"),
                    )
                    expect(compactions).toBe(1)
                    return
                  }
                  const child = await Cortex.prepare({
                    parentSessionID: session.id,
                    parentMessageID: result.info.id,
                    agent: "fixture",
                    description: "Complete a synthetic child task",
                    prompt: "Perform the synthetic task.",
                    executionRole: "primary",
                    model: { providerID: "fixture", modelID: "approved" },
                    notifyParentOnComplete: false,
                  })
                  await Cortex.start(child.id)
                  expect(
                    (await Cortex.waitFor(child.id, Math.max(0, deadline - performance.now()) / 1000))?.status,
                  ).toBe("completed")
                  expect(prompts).toHaveLength(4)
                  for (const prompt of prompts.slice(2)) {
                    expect(prompt.includes("child memory")).toBe(true)
                    expect(prompt.split("<fixture-context>")).toHaveLength(2)
                  }
                  expect(collected).toEqual([true, false])
                  expect(committed).toEqual([session.id, child.sessionID])
                  expect(compactions).toBe(mode === "tool-compaction" ? 2 : 0)
                  if (mode === "tool-compaction") {
                    expect(compactionRequests).toHaveLength(2)
                    expect(compactionRequests[0]?.toolChoice).toEqual({ type: "none" })
                    expect(compactionRequests[0]?.tools).toEqual(conversationRequests[0]?.tools)
                    const stableSystem = conversationRequests[0]?.prompt.filter((message) => message.role === "system")
                    expect(compactionRequests[0]?.prompt.filter((message) => message.role === "system")).toEqual(
                      stableSystem,
                    )
                    expect(JSON.stringify(compactionRequests[0]?.prompt.at(-1))).toContain(
                      "Write the compaction continuation summary now.",
                    )
                  }
                  if (mode === "tool-compaction")
                    for (const sessionID of [session.id, child.sessionID]) {
                      const summaries = (await Session.messages({ sessionID })).filter(
                        (message) => message.info.role === "assistant" && message.info.summary,
                      )
                      expect(summaries).toHaveLength(1)
                      expect(JSON.stringify(summaries[0]!.parts).includes("memory</fixture-context>")).toBe(false)
                    }
                },
              }),
            )
          } finally {
            await runtime.run(() => Cortex.stop())
          }
        },
        TEST_TIMEOUT_MS,
      )
    }
  }
}

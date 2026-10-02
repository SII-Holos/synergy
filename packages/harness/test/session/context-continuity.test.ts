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
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

for (const backend of storageTestBackends()) {
  for (const mode of ["tool", "tool-compaction", "initial-compaction", "queued-task"] as const) {
    test(`${backend}: ${mode} retains task context at the model boundary`, async () => {
      const prompts: string[] = []
      const collected: boolean[] = []
      const committed: string[] = []
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
            prompts.push(JSON.stringify(input.prompt))
            const tool = mode !== "initial-compaction" && calls++ % 2 === 0
            return stream(
              tool
                ? [
                    { type: "tool-call", toolCallId: `fixture-call-${calls}`, toolName: "fixture_step", input: "{}" },
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
      const sdk: ProviderV2 = {
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
            async contribute(input) {
              collected.push(input.isTopSession)
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
                if (mode === "queued-task" && calls === 1)
                  await SessionInbox.enqueueUser({
                    sessionID: context.sessionID,
                    agent: "fixture",
                    model: { providerID: "fixture", modelID: "approved" },
                    parts: [{ type: "text", text: "Perform the next synthetic task." }],
                  })
                if (mode === "tool-compaction") {
                  const message = await MessageV2.get({ sessionID: context.sessionID, messageID: context.messageID })
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
              if (mode === "initial-compaction")
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: input.messageID,
                  type: "compaction",
                  auto: true,
                })
              const result = await SessionInvoke.invoke(input)
              const expectedCalls = mode === "initial-compaction" ? 1 : mode === "queued-task" ? 4 : 2
              expect(prompts).toHaveLength(expectedCalls)
              for (const prompt of prompts) expect(prompt.includes("root memory")).toBe(true)
              if (mode === "queued-task") {
                for (const prompt of prompts.slice(0, 2)) expect(prompt.includes("root memory 1")).toBe(true)
                for (const prompt of prompts.slice(2)) expect(prompt.includes("root memory 2")).toBe(true)
                expect(collected).toEqual([true, true])
                expect(committed).toEqual([session.id, session.id])
                return
              }
              expect(collected).toEqual([true])
              expect(committed).toEqual([session.id])
              if (mode === "initial-compaction") {
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
              expect((await Cortex.waitFor(child.id, 10))?.status).toBe("completed")
              expect(prompts).toHaveLength(4)
              for (const prompt of prompts.slice(2)) {
                expect(prompt.includes("child memory")).toBe(true)
                expect(prompt.split("<fixture-context>")).toHaveLength(2)
              }
              expect(collected).toEqual([true, false])
              expect(committed).toEqual([session.id, child.sessionID])
              expect(compactions).toBe(mode === "tool-compaction" ? 2 : 0)
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
    }, 20000)
  }
}

import { expect, spyOn, test } from "bun:test"
import { APICallError, simulateReadableStream } from "ai"
import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider"
import { AgentPromptContributions } from "../../src/agent/prompt-contributions"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { createUserMessage } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionPluginHooks } from "../../src/session/plugin-hooks"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { WorkflowKindRegistry } from "../../src/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "../../src/session/workflow-prompt-registry"
import { z } from "zod"
import { testRuntime } from "../support/runtime"

type Request = Pick<Parameters<LanguageModelV4["doStream"]>[0], "prompt" | "tools" | "toolChoice" | "maxOutputTokens">

async function budgetFixture(
  agentWords: number,
  options: { budgetWords?: number; output?: number; overflowThreshold?: number; providerOverflow?: boolean } = {},
) {
  const requests: Request[] = []
  const decisions: PromptBudgeter.Decision[] = []
  let preparations = 0
  let parameters = 0
  let workflowCalls = 0
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream(input) {
      const { prompt, tools, toolChoice, maxOutputTokens } = input
      requests.push(structuredClone({ prompt, tools, toolChoice, maxOutputTokens }))
      const summary = input.toolChoice?.type === "none"
      if (
        !summary &&
        options.providerOverflow &&
        prompt.some((message) => message.role === "system" && message.content.includes("agent-marker"))
      ) {
        throw new APICallError({
          message: "context_length_exceeded: fixture provider rejected the root request",
          url: "https://fixture.invalid/v1/responses",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        })
      }
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "text-start", id: "reply" },
            { type: "text-delta", id: "reply", delta: summary ? "Earlier evidence was inspected." : "Completed." },
            { type: "text-end", id: "reply" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      }
    },
  }
  const sdk: ProviderV4 = {
    specificationVersion: "v4",
    languageModel: () => model,
    embeddingModel() {
      throw new Error("Unexpected embedding call")
    },
    imageModel() {
      throw new Error("Unexpected image call")
    },
  }
  const runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/fixture",
        compaction: { auto: true, prune: false, codexRemote: false, overflowThreshold: options.overflowThreshold },
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
            models: {
              fixture: {
                id: "fixture",
                name: "Fixture",
                release_date: "2026-10-01",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                limit: { context: 65_536, output: options.output ?? 8_192 },
                options: {},
              },
            },
          },
        },
        agent: {
          fixture: {
            mode: "all",
            permission: { "*": "allow" },
            prompt: `agent-marker ${"evidence ".repeat(agentWords)}`,
          },
        },
      }),
    },
    register() {
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
      WorkflowKindRegistry.register({
        id: "budget-fixture",
        schema: z.object({ kind: z.literal("budget-fixture") }),
        conflicts: [],
        async enable({ sessionID }) {
          return Session.update(sessionID, (draft) => {
            draft.workflow = { kind: "budget-fixture" }
          })
        },
      })
      WorkflowPromptRegistry.register({
        kind: "budget-fixture",
        onModelCall: () => {
          workflowCalls++
        },
      })
      AgentPromptContributions.register("budget-fixture", [{ requiredTools: [], render: () => "contribution-marker" }])
      SessionPluginHooks.registerTrigger(async (point, context, initial) => {
        if (
          point === "chat.system.transform" &&
          (context as { phase?: string }).phase === "budget" &&
          options.budgetWords
        ) {
          ;(initial as { system: string[] }).system.push(
            `budget-only-marker ${"estimate ".repeat(options.budgetWords)}`,
          )
        }
        if (
          point === "chat.system.transform" &&
          (context as { phase?: string; agent?: string }).phase === "final" &&
          (context as { agent?: string }).agent === "fixture"
        ) {
          preparations++
          const value = initial as { system: string[] }
          value.system = value.system.filter((part) => !part.startsWith("budget-only-marker"))
          value.system.push("final-hook-marker")
        }
        if (point === "chat.params" && (context as { agent?: { name?: string } }).agent?.name === "fixture")
          parameters++
        return initial
      })
    },
  })
  const originalDecide = PromptBudgeter.decide
  const decide = spyOn(PromptBudgeter, "decide").mockImplementation(async (...args) => {
    const result = await originalDecide(...args)
    if (args[0].system.some((part) => part.includes("agent-marker"))) decisions.push(result)
    return result
  })
  return {
    allRequests: requests,
    get requests() {
      return requests.filter((request) =>
        request.prompt.some((message) => message.role === "system" && message.content.includes("agent-marker")),
      )
    },
    decisions,
    enableWorkflow: (sessionID: string) => WorkflowKindRegistry.get("budget-fixture")!.enable({ sessionID, args: {} }),
    get workflowCalls() {
      return workflowCalls
    },
    get preparations() {
      return preparations
    },
    get parameters() {
      return parameters
    },
    run: runtime.run,
    async [Symbol.asyncDispose]() {
      decide.mockRestore()
      await runtime.close()
    },
  }
}

async function addHistory(sessionID: string, chunks: string[]) {
  const root = await createUserMessage({
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "fixture",
    model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "Preserve earlier observed constraints." }],
  })
  for (const text of chunks) {
    const now = Date.now()
    const assistant = await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID,
      role: "assistant",
      rootID: root.info.id,
      parentID: root.info.id,
      agent: "fixture",
      mode: "fixture",
      modelID: "fixture",
      providerID: "fixture",
      path: { cwd: null, root: null },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: now, completed: now },
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID,
      messageID: assistant.id,
      type: "text",
      text,
    })
  }
}

test("admits a root-only soft-pressure request after complete preparation without a summary", async () => {
  await using fixture = await budgetFixture(48_000)
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Budget regression" })
        const result = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          system: "user-system-marker",
          parts: [{ type: "text", text: "Complete this root task." }],
        })
        expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.maxOutputTokens).toBe(8_192)
        expect(fixture.decisions.at(-1)).toMatchObject({ shouldCompact: true, contextExceeded: false })
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
        expect(messages.some((message) => message.info.role === "assistant" && message.info.error)).toBe(false)
        const prompt = JSON.stringify(fixture.requests[0]?.prompt)
        for (const marker of ["agent-marker", "contribution-marker", "user-system-marker", "final-hook-marker"]) {
          expect(prompt.split(marker)).toHaveLength(2)
        }
        expect(fixture.preparations).toBe(1)
        expect(fixture.parameters).toBe(1)
      },
    }),
  )
}, 20_000)

test("progressively compacts real history until the complete request fits", async () => {
  await using fixture = await budgetFixture(0)
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Progressive compaction" })
        await addHistory(
          session.id,
          Array.from({ length: 6 }, (_, index) => `history-${index} ${"evidence ".repeat(20_000)}`),
        )
        const result = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          parts: [{ type: "text", text: "Continue after progressive compaction." }],
        })
        expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
        const messages = await Session.messages({ sessionID: session.id })
        const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
        expect(summaries.length).toBeGreaterThan(1)
        expect(fixture.requests.filter((request) => request.toolChoice?.type === "none")).toHaveLength(summaries.length)
        expect(fixture.requests.filter((request) => request.toolChoice?.type !== "none")).toHaveLength(1)
        expect(messages.some((message) => message.info.role === "assistant" && message.info.error)).toBe(false)
        expect(fixture.preparations).toBe(summaries.length + 1)
      },
    }),
  )
}, 20_000)

test("compacts a hard-overflowing complete request even below its soft threshold", async () => {
  await using fixture = await budgetFixture(0, { output: 65_536, overflowThreshold: 0.99 })
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Hard pressure below soft" })
        await addHistory(
          session.id,
          Array.from({ length: 3 }, (_, index) => `history-${index} ${"evidence ".repeat(20_500)}`),
        )
        await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          parts: [{ type: "text", text: "Recover response space." }],
        })
        expect(fixture.decisions[0]).toEqual(expect.objectContaining({ contextExceeded: true, shouldCompact: false }))
        expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests[0]!.toolChoice?.type).toBe("none")
        expect(fixture.requests[1]!.toolChoice?.type).not.toBe("none")
      },
    }),
  )
}, 20_000)

test("preserves a root-only provider context error instead of replacing it with a successful no-op", async () => {
  await using fixture = await budgetFixture(0, { providerOverflow: true })
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Provider root overflow" })
        await expect(
          SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Return the provider error faithfully." }],
          }),
        ).rejects.toBeInstanceOf(MessageV2.SessionTerminalError)
        expect(fixture.requests).toHaveLength(1)
        const messages = await Session.messages({ sessionID: session.id })
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(assistants).toHaveLength(1)
        expect(assistants[0]!.info).toMatchObject({
          finish: "error",
          error: {
            name: "APIError",
            data: { statusCode: 400, message: "context_length_exceeded: fixture provider rejected the root request" },
          },
        })
        expect(messages.flatMap((message) => message.parts).some((part) => part.type === "compaction")).toBe(false)
      },
    }),
  )
}, 20_000)

for (const auto of [false, true])
  test(`settles a root-only ${auto ? "automatic" : "manual"} compaction as a durable no-op`, async () => {
    await using fixture = await budgetFixture(0)
    await fixture.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const session = await Session.create({ workspace: null, title: "No-op compaction" })
          await fixture.enableWorkflow(session.id)
          const root = await createUserMessage({
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            agent: "fixture",
            model: { providerID: "fixture", modelID: "fixture" },
            parts: [{ type: "text", text: "There is no history to summarize." }],
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: root.info.id,
            type: "compaction",
            auto,
          })
          const result = await SessionInvoke.loop.force(session.id)
          expect(result.info).toMatchObject({
            role: "assistant",
            mode: "compaction",
            finish: "stop",
            visible: false,
            includeInContext: false,
            metadata: { compactionAttempt: { state: "empty", reason: "no-history" } },
          })
          const before = await Session.messages({ sessionID: session.id })
          const savedRoot = await MessageV2.get({ sessionID: session.id, messageID: root.info.id })
          expect(savedRoot.parts.filter((part) => part.type === "compaction")).toHaveLength(1)
          expect(SessionCompaction.hasPendingCompaction(savedRoot.parts, before, root.info.id)).toBe(false)
          expect(
            before.some((message) => message.info.role === "assistant" && (message.info.summary || message.info.error)),
          ).toBe(false)
          expect(before.flatMap((message) => message.parts).some((part) => part.type === "compaction_recovery")).toBe(
            false,
          )
          expect(fixture.allRequests).toHaveLength(0)
          await SessionInvoke.loop.force(session.id)
          expect(await Session.messages({ sessionID: session.id })).toEqual(before)
          expect(fixture.preparations).toBe(1)
          expect(fixture.workflowCalls).toBe(0)
          expect(SessionCompaction.hasPendingCompaction(savedRoot.parts, [savedRoot], root.info.id)).toBe(false)
          if (!auto) {
            const fork = await Session.fork({ sessionID: session.id })
            const forkMessages = await Session.messages({ sessionID: fork.id })
            const forkRoot = forkMessages.find((message) => message.info.role === "user" && message.info.isRoot)!
            expect(forkRoot.parts[0]!.id).not.toBe(savedRoot.parts[0]!.id)
            expect(SessionCompaction.hasPendingCompaction(forkRoot.parts, forkMessages, forkRoot.info.id)).toBe(false)
          }
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: root.info.id,
            type: "compaction",
            auto,
          })
          const nextRoot = await MessageV2.get({ sessionID: session.id, messageID: root.info.id })
          expect(SessionCompaction.hasPendingCompaction(nextRoot.parts, [nextRoot], root.info.id)).toBe(true)
        },
      }),
    )
  }, 20_000)

test("clamps output for an admissible root-only request beyond the soft reserve", async () => {
  await using fixture = await budgetFixture(56_000)
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Clamped output" })
        await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          parts: [{ type: "text", text: "Reply normally." }],
        })
        expect(fixture.requests).toHaveLength(1)
        const output = fixture.requests[0]!.maxOutputTokens!
        expect(output).toBeGreaterThan(0)
        expect(output).toBeLessThan(8_192)
        expect(output).toBe(fixture.decisions.at(-1)!.maxOutputTokens!)
        expect(fixture.requests[0]!.toolChoice?.type).not.toBe("none")
      },
    }),
  )
}, 20_000)

test("rejects a root-only hard overflow before any provider or summary call", async () => {
  await using fixture = await budgetFixture(65_000)
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Hard overflow" })
        await fixture.enableWorkflow(session.id)
        await expect(
          SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "This cannot fit." }],
          }),
        ).rejects.toBeInstanceOf(MessageV2.SessionTerminalError)
        expect(fixture.allRequests).toHaveLength(0)
        expect(fixture.workflowCalls).toBe(0)
        const messages = await Session.messages({ sessionID: session.id })
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(assistants).toHaveLength(1)
        expect(assistants[0]!.info).toMatchObject({ finish: "error" })
        expect(JSON.stringify(assistants[0]!.info)).toContain("ContextBudgetExceededError")
        expect(messages.flatMap((message) => message.parts).some((part) => part.type === "compaction")).toBe(false)
      },
    }),
  )
}, 20_000)

test("compacts history under prepared soft pressure without a failed preliminary assistant", async () => {
  await using fixture = await budgetFixture(41_000)
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Prepared history pressure" })
        await fixture.enableWorkflow(session.id)
        await createUserMessage({
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          agent: "fixture",
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: `history-marker ${"observations ".repeat(8_000)}` }],
        })
        const result = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          system: "user-system-marker",
          parts: [{ type: "text", text: "Continue the current task." }],
        })
        expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
        expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests[0]!.toolChoice?.type).toBe("none")
        expect(fixture.requests[1]!.toolChoice?.type).not.toBe("none")
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
        expect(messages.some((message) => message.info.role === "assistant" && message.info.error)).toBe(false)
        for (const request of fixture.requests) {
          const prompt = JSON.stringify(request.prompt)
          for (const marker of ["agent-marker", "contribution-marker", "user-system-marker", "final-hook-marker"])
            expect(prompt.split(marker)).toHaveLength(2)
        }
        expect(fixture.preparations).toBe(2)
        expect(fixture.parameters).toBe(2)
        expect(fixture.workflowCalls).toBe(1)
      },
    }),
  )
}, 20_000)

test("does not use an overflowing incomplete plan to reject or summarize an admissible final request", async () => {
  await using fixture = await budgetFixture(0, { budgetWords: 70_000 })
  await fixture.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Final admission" })
        await createUserMessage({
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          agent: "fixture",
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: "Earlier history must remain intact." }],
        })
        await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          parts: [{ type: "text", text: "Reply using the final request." }],
        })
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]!.toolChoice?.type).not.toBe("none")
        expect(JSON.stringify(fixture.requests[0]!.prompt)).not.toContain("budget-only-marker")
        expect(fixture.decisions.at(-1)).toMatchObject({ shouldCompact: false, contextExceeded: false })
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
      },
    }),
  )
}, 20_000)

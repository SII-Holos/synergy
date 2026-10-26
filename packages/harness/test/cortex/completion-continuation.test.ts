import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import { z } from "zod"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { TaskOutputTool } from "../../src/cortex/tools/task-output"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { testRuntime } from "../support/runtime"

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Continuation did not settle")
    await Bun.sleep(5)
  }
}

test("an older root's Cortex completion continues the latest completed root exactly once", async () => {
  const releaseChild = Promise.withResolvers<void>()
  const childStarted = Promise.withResolvers<void>()
  const prompts: string[] = []
  let task: Awaited<ReturnType<typeof Cortex.launch>> | undefined
  let launches = 0
  const stream = (chunks: LanguageModelV2StreamPart[]) => ({
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  })
  const reply = (text: string) =>
    stream([
      { type: "text-start", id: "reply" },
      { type: "text-delta", id: "reply", delta: text },
      { type: "text-end", id: "reply" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ])
  const call = (toolName: string, input: string) =>
    stream([
      { type: "tool-call", toolCallId: `call-${prompts.length}`, toolName, input },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ])
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "fixture",
    modelId: "parent",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream(input) {
      prompts.push(JSON.stringify(input.prompt))
      if (prompts.length === 1) return call("fixture_delegate", "{}")
      if (prompts.length === 4) return call("task_output", JSON.stringify({ taskId: task!.id, mode: "full" }))
      return reply(prompts.length === 5 ? "Integrated the background result." : "Waiting for the background result.")
    },
  }
  const child: LanguageModelV2 = {
    ...model,
    modelId: "child",
    async doStream() {
      childStarted.resolve()
      await releaseChild.promise
      return reply("Background evidence: VERIFIED-827.")
    },
  }
  const auxiliary: LanguageModelV2 = { ...model, modelId: "auxiliary", doStream: async () => reply("Fixture") }
  const sdk: ProviderV2 = {
    languageModel: (id) => (id === "child" ? child : id === "auxiliary" ? auxiliary : model),
    textEmbeddingModel() {
      throw new Error("Unexpected embedding")
    },
    imageModel() {
      throw new Error("Unexpected image")
    },
  }
  await using runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/parent",
        nano_model: "fixture/auxiliary",
        mini_model: "fixture/auxiliary",
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
            models: Object.fromEntries(
              ["parent", "child", "auxiliary"].map((id) => [
                id,
                { id, name: id, limit: { context: 128000, output: 8000 }, tool_call: true },
              ]),
            ),
          },
        },
        agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
      }),
    },
    register() {
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
      registerCortexSessionRuntime()
      const delegate = Tool.define(
        "fixture_delegate",
        {
          description: "Start independent work.",
          parameters: z.object({}),
          async execute(_, context) {
            launches++
            task = await Cortex.launch({
              parentSessionID: context.sessionID,
              parentMessageID: context.messageID,
              description: "Deferred evidence",
              prompt: "Return the evidence.",
              agent: "fixture",
              executionRole: "delegated_subagent",
              model: { providerID: "fixture", modelID: "child" },
              output: { mode: "final_response" },
            })
            return { title: "Delegated", output: task.id, metadata: {} }
          },
        },
        { requiresWorkspace: false },
      )
      ToolRegistry.registerToolProvider("fixture", () =>
        [delegate, TaskOutputTool].map((tool) => ({ ...tool, exposure: { mode: "resident" } })),
      )
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Continuation fixture" })
        const owner = RolloutLifecycle.owner(session)
        try {
          const first = await SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Delegate independent work and finish this reply." }],
          })
          await childStarted.promise
          const second = await SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Handle this newer request while the background task runs." }],
          })
          const firstRoot = first.info.rootID!
          const latestRoot = second.info.rootID!
          expect(firstRoot).not.toBe(latestRoot)
          await until(async () => (await RolloutLedger.getRun(owner, latestRoot)).status === "completed")
          expect((await RolloutLedger.getRun(owner, firstRoot)).status).toBe("running")
          const before = await RolloutLedger.getRun(owner, latestRoot)
          const firstSegments = await RolloutLedger.segments(owner, firstRoot)
          const latestSegments = await RolloutLedger.segments(owner, latestRoot)
          expect(prompts).toHaveLength(3)

          releaseChild.resolve()
          await until(async () => {
            const current = await Session.get(session.id)
            if (current.paused) throw new Error(current.paused.description)
            return prompts.length === 5 && !SessionManager.isRunning(session.id)
          })
          await until(async () => (await RolloutLedger.getRun(owner, latestRoot)).status === "completed")
          await until(async () => (await RolloutLedger.getRun(owner, firstRoot)).status === "completed")
          const messages = await Session.messages({ sessionID: session.id })
          const notices = messages.filter(
            (message) => message.info.role === "user" && message.info.origin?.type === "cortex",
          )
          expect(notices).toHaveLength(1)
          expect(notices[0]!.info).toMatchObject({ rootID: latestRoot, isRoot: false })
          expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(2)
          expect(messages.at(-1)!.info).toMatchObject({ rootID: latestRoot, finish: "stop" })
          expect(prompts[3]).toContain("BACKGROUND TASK COMPLETED")
          expect(prompts[4]).toContain("VERIFIED-827")
          expect(launches).toBe(1)
          expect(await RolloutLedger.segments(owner, firstRoot)).toEqual(firstSegments)
          const segments = await RolloutLedger.segments(owner, latestRoot)
          expect(segments).toHaveLength(2)
          expect(segments).toEqual(expect.arrayContaining(latestSegments))
          expect(segments.every((segment) => segment.status === "completed")).toBe(true)
          expect((await RolloutLedger.getRun(owner, latestRoot)).input).toEqual(before.input)
          expect((await Session.get(task!.sessionID)).cortex).toMatchObject({
            status: "completed",
            notifyParentOnComplete: false,
          })
          expect(await SessionInbox.list(session.id)).toHaveLength(0)
          await Cortex.reconcileParentNotifications(session.scope.id)
          await SessionInvoke.loop(session.id)
          expect(prompts).toHaveLength(5)
          expect(await RolloutLedger.segments(owner, latestRoot)).toHaveLength(2)
        } finally {
          releaseChild.resolve()
          await Cortex.cancelAll(session.id)
          await Cortex.drain()
          await SessionManager.waitForIdle(session.id)
          await Session.remove(session.id)
        }
      },
    }),
  )
}, 15_000)

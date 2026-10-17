import { expect, mock, spyOn, test } from "bun:test"
import { simulateReadableStream, type LanguageModel as Model, type Provider } from "ai"
import { z } from "zod"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionSendTool } from "../../src/tools/session-send"
import { testRuntime } from "../support/runtime"
import { LoopJob } from "../../../harness/src/session/loop-job"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"

for (const scenario of [
  "next-call",
  "cancel-inflight",
  "complete-during-permission",
  "completed-root-boundary",
  "post-stop",
  "cancel-with-control-held",
] as const)
  test(`parent follow-up lifecycle: ${scenario}`, async () => {
    const prompts: string[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const postStarted = Promise.withResolvers<void>()
    const releasePost = Promise.withResolvers<void>()
    let toolSignal: AbortSignal | undefined
    let toolFinished = false
    type LanguageModel = Exclude<Model, string>
    type Stream = Awaited<ReturnType<LanguageModel["doStream"]>>["stream"]
    type StreamPart = Stream extends ReadableStream<infer Part> ? Part : never
    const stream = (chunks: StreamPart[]) => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    })
    const reply = (): StreamPart[] => [
      { type: "text-start", id: "reply" },
      { type: "text-delta", id: "reply", delta: "Completed the requested work." },
      { type: "text-end", id: "reply" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } },
    ]
    const model: LanguageModel = {
      specificationVersion: "v2",
      provider: "fixture",
      modelId: "worker",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Unexpected non-streaming call")
      },
      async doStream(input) {
        prompts.push(JSON.stringify(input.prompt))
        return stream(
          prompts.length === 1
            ? [
                { type: "tool-call", toolCallId: "held-step", toolName: "fixture_hold", input: "{}" },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
                },
              ]
            : reply(),
        )
      },
    }
    const auxiliary: LanguageModel = { ...model, modelId: "auxiliary", doStream: async () => stream(reply()) }
    const sdk: Provider = {
      languageModel: (id) => (id === "auxiliary" ? auxiliary : model),
      textEmbeddingModel() {
        throw new Error("Unexpected embedding call")
      },
      imageModel() {
        throw new Error("Unexpected image call")
      },
    }
    const modelConfig = {
      name: "Fixture",
      release_date: "2026-10-01",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      limit: { context: 128000, output: 8000 },
      options: {},
    }
    await using runtime = await testRuntime({
      env: {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/worker",
          nano_model: "fixture/auxiliary",
          mini_model: "fixture/auxiliary",
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
              models: {
                worker: { ...modelConfig, id: "worker" },
                auxiliary: { ...modelConfig, id: "auxiliary" },
              },
            },
          },
          agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
        }),
      },
      register() {
        ProviderSdkSource.register(undefined)
        ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
        const hold = Tool.define(
          "fixture_hold",
          {
            description: "Wait for the deterministic test handoff.",
            parameters: z.object({}),
            async execute(_, context) {
              toolSignal = context.abort
              started.resolve()
              await release.promise
              toolFinished = true
              return { title: "Finished", output: "The held work finished normally.", metadata: {} }
            },
          },
          { requiresWorkspace: false },
        )
        ToolRegistry.registerToolProvider("fixture", () => [{ ...hold, exposure: { mode: "resident" } }])
        if (scenario === "post-stop")
          LoopJob.register({
            type: "fixture-stop",
            phase: "post",
            blocking: true,
            collect: (context) => (context.step === 2 ? [{ type: "fixture-stop" }] : []),
            async execute() {
              postStarted.resolve()
              await releasePost.promise
              return "stop"
            },
          })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const parent = await Session.create({ workspace: null })
          const task = await Cortex.launch({
            description: "Receive a parent correction",
            prompt: "Perform the original fixture work.",
            agent: "fixture",
            executionRole: "delegated_subagent",
            parentSessionID: parent.id,
            parentMessageID: Identifier.ascending("message"),
            model: { providerID: "fixture", modelID: "worker" },
            notifyParentOnComplete: false,
            output: { mode: "final_response" },
          })
          try {
            await Promise.race([
              started.promise,
              Cortex.waitFor(task.id, 5).then(() => {
                throw new Error(`Child did not reach the held tool: ${JSON.stringify(Cortex.get(task.id))}`)
              }),
            ])
            const before = await Session.messages({ sessionID: task.sessionID })
            const root = before.find((message) => message.info.role === "user" && message.info.isRoot)
            expect(root).toBeDefined()
            const correction = "PARENT-CORRECTION-827: prioritize the existing regression, not extra features."
            const ask = mock(async () => {})
            const tool = await SessionSendTool.init()
            const send = () =>
              tool.execute(
                { target: task.sessionID, content: correction, role: "user" },
                {
                  sessionID: parent.id,
                  messageID: Identifier.ascending("message"),
                  callID: "call_parent_followup",
                  agent: "fixture",
                  abort: AbortSignal.any([]),
                  metadata: () => {},
                  ask: async () => {
                    await ask()
                    if (scenario === "complete-during-permission") {
                      release.resolve()
                      await Cortex.drain(task.id)
                    }
                  },
                },
              )
            if (scenario === "complete-during-permission") {
              SessionManager.closeAdmission()
              try {
                const result = await send()
                const pending = await SessionInbox.list(task.sessionID)
                expect(Cortex.get(task.id)?.status).toBe("completed")
                expect(prompts).toHaveLength(2)
                expect(prompts[1]).not.toContain(correction)
                expect(result.metadata.mode).toBe("task")
                expect(pending[0]?.mode).toBe("task")
                expect(SessionManager.isRunning(task.sessionID)).toBe(false)
                await SessionInbox.remove({ sessionID: task.sessionID, itemID: pending[0]!.id })
              } finally {
                SessionManager.openAdmission()
              }
              return
            }
            if (scenario === "completed-root-boundary") {
              const other = await Session.create({ workspace: null })
              const queued = await tool.execute(
                { target: task.sessionID, content: "INDEPENDENT-TASK-B", role: "user" },
                {
                  sessionID: other.id,
                  messageID: Identifier.ascending("message"),
                  callID: "call_independent_task",
                  agent: "fixture",
                  abort: AbortSignal.any([]),
                  metadata: () => {},
                  ask: async () => {},
                },
              )
              const reached = Promise.withResolvers<void>()
              const resume = Promise.withResolvers<void>()
              const notice = Session.recordCompletionNotice
              let held = false
              using heldNotice = spyOn(Session, "recordCompletionNotice").mockImplementation(async (id, options) => {
                if (id === task.sessionID && !held) {
                  held = true
                  reached.resolve()
                  await resume.promise
                }
                return notice(id, options)
              })
              release.resolve()
              try {
                await reached.promise
                const result = await send()
                resume.resolve()
                await Cortex.drain(task.id)
                const messages = await Session.messages({ sessionID: task.sessionID })
                const followup = messages.find((message) => message.info.id === result.metadata.messageID)
                expect(result.metadata.mode).toBe("task")
                expect(followup?.info).toMatchObject({ isRoot: true, rootID: result.metadata.messageID })
                expect(followup?.info.rootID).not.toBe(queued.metadata.messageID)
                const turn = messages.find(
                  (message) => message.info.role === "assistant" && message.info.rootID === result.metadata.messageID,
                )
                expect(turn).toBeDefined()
                expect(prompts[2]).toContain(correction)
              } finally {
                resume.resolve()
              }
              return
            }
            if (scenario === "post-stop") {
              release.resolve()
              await postStarted.promise
              const result = await send()
              expect(result.metadata.mode).toBe("steer")
              releasePost.resolve()
              await Cortex.drain(task.id)
              await SessionManager.drain()
              const pending = await SessionInbox.list(task.sessionID)
              expect(prompts).toHaveLength(2)
              expect(prompts[1]).not.toContain(correction)
              expect(pending).toHaveLength(1)
              expect(pending[0]).toMatchObject({ mode: "steer", status: "failed" })
              expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(false)
              await LoopJob.settleDetached(task.sessionID, new Set([root!.info.id]))
              await RolloutLifecycle.reconcile(task.sessionID, root!.info.id)
              expect(
                (await RolloutLedger.getRun(RolloutLifecycle.owner(await Session.get(task.sessionID)), root!.info.id))
                  .status,
              ).toBe("completed")
              return
            }
            if (scenario === "cancel-with-control-held") {
              const result = await send()
              expect(result.metadata.mode).toBe("steer")
              using control = await Lock.write(`session-control:${task.sessionID}`)
              await Cortex.cancel(task.id)
              release.resolve()
              await Cortex.drain(task.id)
              expect(SessionManager.isRunning(task.sessionID)).toBe(false)
              expect(await SessionInbox.list(task.sessionID)).toEqual([])
              expect(prompts).toHaveLength(1)
              return
            }
            if (scenario === "cancel-inflight") {
              const writing = Promise.withResolvers<void>()
              const releaseWrite = Promise.withResolvers<void>()
              const write = Storage.write
              using heldWrite = spyOn(Storage, "write").mockImplementation(async (key, value) => {
                if (key.includes(task.sessionID) && key.some((part) => part.startsWith("inb_"))) {
                  writing.resolve()
                  await releaseWrite.promise
                }
                return write(key, value)
              })
              const sending = send()
              let cancelling: Promise<void> | undefined
              try {
                await writing.promise
                cancelling = Cortex.cancel(task.id)
              } finally {
                releaseWrite.resolve()
              }
              const result = await sending
              await cancelling
              expect(result.metadata.mode).toBe("steer")
              expect(toolSignal?.aborted).toBe(true)
              expect(await SessionInbox.list(task.sessionID)).toEqual([])
              release.resolve()
              await Cortex.drain(task.id)
              await SessionManager.drain()
              expect(prompts).toHaveLength(1)
              expect(Cortex.get(task.id)?.status).toBe("cancelled")
              expect(SessionManager.isRunning(task.sessionID)).toBe(false)
              expect(
                (await Session.messages({ sessionID: task.sessionID })).filter(
                  (message) => message.info.role === "user" && message.info.isRoot,
                ),
              ).toHaveLength(1)
              return
            }
            const result = await send()
            const pending = await SessionInbox.list(task.sessionID)
            expect(SessionManager.isRunning(task.sessionID)).toBe(true)
            expect(toolSignal?.aborted).toBe(false)
            expect(toolFinished).toBe(false)
            release.resolve()
            await Cortex.drain(task.id)

            expect(prompts[0]).not.toContain(correction)
            expect(prompts[1]).toContain(correction)
            expect(prompts).toHaveLength(2)
            expect(pending).toHaveLength(1)
            expect(pending[0]?.mode).toBe("steer")
            expect(result.metadata.mode).toBe("steer")
            expect(result.output).toContain("next model call")
            expect(result.output).toContain("not a read acknowledgement")
            expect(ask).toHaveBeenCalledTimes(1)
            expect(toolFinished).toBe(true)
            expect(Cortex.get(task.id)?.status).toBe("completed")
            expect(await SessionInbox.list(task.sessionID)).toEqual([])
            const messages = await Session.messages({ sessionID: task.sessionID })
            expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(1)
            const followup = messages.find((message) => message.info.id === pending[0]?.messageID)
            expect(followup?.info).toMatchObject({ isRoot: false, rootID: root?.info.id })
            expect(
              messages.flatMap((message) => message.parts).find((part) => part.type === "tool")?.state.status,
            ).toBe("completed")
          } finally {
            release.resolve()
            releasePost.resolve()
            await Cortex.cancel(task.id)
            await Cortex.drain(task.id)
          }
        },
      }),
    )
  }, 20_000)

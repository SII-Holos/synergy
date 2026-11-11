import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { registerCortexTools } from "../../src/cortex/tools"
import { Bus } from "../../src/bus"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

for (const operation of ["prepare", "cancel"] as const)
  test(`source ${operation} preserves the actual synchronous TaskTool child when its parent turn stops`, async () => {
    const childStarted = Promise.withResolvers<void>()
    const taskWaiting = Promise.withResolvers<string>()
    let parentCalls = 0
    let childCalls = 0
    const stream = (chunks: LanguageModelV2StreamPart[]) => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    })
    const parent: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "fixture",
      modelId: "parent",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Unexpected generation")
      },
      async doStream() {
        parentCalls++
        if (parentCalls > 1) throw new Error("Unexpected second parent request before source freeze")
        return stream([
          {
            type: "tool-call",
            toolCallId: "delegate-once",
            toolName: "task",
            input: JSON.stringify({
              taskTitle: "Preserve this delegation",
              taskInstructions: "Do this original child task exactly once",
              subagent_type: "delegate_fixture",
              model: "fixture/child",
              output: { mode: "final_response" },
            }),
          },
          { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        ])
      },
    }
    const child: LanguageModelV2 = {
      ...parent,
      modelId: "child",
      async doStream(input) {
        childCalls++
        childStarted.resolve()
        await new Promise<void>((_resolve, reject) => {
          if (input.abortSignal?.aborted) reject(input.abortSignal.reason)
          else input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true })
        })
        throw new Error("Fixture child must stop through its native owner")
      },
    }
    const auxiliary: LanguageModelV2 = {
      ...parent,
      modelId: "auxiliary",
      async doStream() {
        return stream([
          { type: "text-start", id: "aux" },
          { type: "text-delta", id: "aux", delta: "Fixture" },
          { type: "text-end", id: "aux" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ])
      },
    }
    const sdk: ProviderV2 = {
      languageModel: (id) => (id === "child" ? child : id === "auxiliary" ? auxiliary : parent),
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
          snapshot: false,
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
          agent: {
            fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." },
            delegate_fixture: {
              mode: "subagent",
              permission: { "*": "allow" },
              prompt: "Complete the delegated fixture task.",
            },
          },
        }),
      },
      register() {
        Core.register()
        registerCortexSessionRuntime()
        registerCortexTools()
        ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const stopObserving = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            const part = event.properties.part
            if (
              part.sessionID !== root.id ||
              part.type !== "tool" ||
              part.tool !== "task" ||
              part.state.status !== "running"
            )
              return
            const sessionID = part.state.metadata?.sessionId
            if (typeof sessionID === "string") taskWaiting.resolve(sessionID)
          })
          const parentTurn = SessionInvoke.invoke({
            sessionID: root.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Delegate one child and wait for its evidence." }],
          }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          const rescue = setTimeout(() => {
            childStarted.reject(new Error("Native child did not start"))
            taskWaiting.reject(new Error("TaskTool did not begin waiting"))
          }, 7000)
          try {
            const [, childID] = await Promise.all([childStarted.promise, taskWaiting.promise])
            const before = await Session.get(childID)
            expect(before.cortex?.status).toBe("running")
            const parentSignal = SessionManager.getRuntime(root.id)?.owner?.lease.signal
            if (!parentSignal || parentSignal.aborted) throw new Error("Native parent lease is unavailable")
            const childAtParentAbort = Promise.withResolvers<Session.Info>()
            parentSignal.addEventListener(
              "abort",
              () => {
                Session.get(childID).then(childAtParentAbort.resolve, childAtParentAbort.reject)
              },
              { once: true },
            )
            const values = new Map<string, Uint8Array>()
            const store = {
              async put(hash: string, bytes: Uint8Array) {
                values.set(hash, bytes.slice())
              },
              async get(hash: string, maximum: number) {
                const value = values.get(hash)
                if (!value || value.length > maximum) throw new Error("Missing or oversized object")
                return value.slice()
              },
            }
            const binding = {
              sessionID: root.id,
              scopeID: root.scope.id,
              handoffID: "actual-parent-task",
              sourceID: "A",
              targetID: "B",
              fromEpoch: 1,
              toEpoch: 2,
            }
            const prepared = await Source[operation]({
              binding,
              store,
              signal: new AbortController().signal,
              async verify() {},
            })
            const after = await Session.get(childID)
            expect((await childAtParentAbort.promise).cortex?.transfer).toMatchObject({
              handoffID: binding.handoffID,
              rootSessionID: root.id,
            })
            expect(after.cortex?.status).toBe("running")
            expect(after.cortex?.taskID).toBe(before.cortex?.taskID)
            expect(after.cortex?.rootID).toBe(before.cortex?.rootID)
            expect(after.cortex?.transfer).toMatchObject({
              handoffID: binding.handoffID,
              rootSessionID: root.id,
              admitted: true,
            })
            expect(prepared.members).toBe(2)
            if (operation === "cancel") {
              expect(await Source.cancellation(binding)).toMatchObject({ binding, manifestHash: null, members: 2 })
              expect(values.size).toBe(0)
              expect((await Epochs.inspect(binding)).phase).toBe("cancelled")
              expect((await Epochs.inspect({ ...binding, sessionID: childID, rootSessionID: root.id })).phase).toBe(
                "cancelled",
              )
            }
            expect(parentCalls).toBe(1)
            expect(childCalls).toBe(1)
            expect(SessionManager.isRunning(root.id)).toBe(false)
            expect(SessionManager.isRunning(childID)).toBe(false)
            expect((await Session.get(root.id)).paused).toBeDefined()
          } finally {
            clearTimeout(rescue)
            stopObserving()
            SessionManager.signalAbort(root.id, { pauseTurn: true })
            await parentTurn
          }
        },
      }),
    )
  }, 20000)

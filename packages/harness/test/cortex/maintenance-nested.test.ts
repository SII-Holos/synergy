import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { registerCortexTools } from "../../src/cortex/tools"
import { Bus } from "../../src/bus"
import { Cortex } from "../../src/cortex"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Identifier } from "../../src/id/id"

test("maintenance holds a native child before aborting its synchronous primary Cortex parent", async () => {
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
      RuntimeMaintenance.configure({ required: ["cortex"] })
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
        const primarySession = await Session.create({
          id: "ses_000_primary",
          parentID: root.id,
          workspaceID: null,
          environmentID: null,
        })
        const primary = await Cortex.prepare({
          parentSessionID: root.id,
          parentMessageID: Identifier.ascending("message"),
          sessionID: primarySession.id,
          executionRole: "primary",
          agent: "fixture",
          model: { providerID: "fixture", modelID: "parent" },
          description: "Primary native task with a synchronous delegation",
          prompt: "Delegate one child and await its original result.",
          notifyParentOnComplete: false,
        })
        const stopObserving = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part
          if (
            part.sessionID !== primary.sessionID ||
            part.type !== "tool" ||
            part.tool !== "task" ||
            part.state.status !== "running"
          )
            return
          const sessionID = part.state.metadata?.sessionId
          if (typeof sessionID === "string") taskWaiting.resolve(sessionID)
        })
        await Cortex.start(primary.id)
        const rescue = setTimeout(() => {
          childStarted.reject(new Error("Native child did not start"))
          taskWaiting.reject(new Error("TaskTool did not begin waiting"))
        }, 7000)
        try {
          const [, childID] = await Promise.all([childStarted.promise, taskWaiting.promise])
          const before = await Session.get(childID)
          const beforePrimary = await Session.get(primary.sessionID)
          expect(before.cortex?.status).toBe("running")
          const parentSignal = SessionManager.getRuntime(primary.sessionID)?.owner?.lease.signal
          if (!parentSignal || parentSignal.aborted) throw new Error("Native primary lease is unavailable")
          const childAtAbort = Promise.withResolvers<Session.Info>()
          parentSignal.addEventListener(
            "abort",
            () => {
              Session.get(childID).then(childAtAbort.resolve, childAtAbort.reject)
            },
            { once: true },
          )
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: "nested-cortex-backup",
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Operator",
              clientKind: "system",
              requestID: "nested-cortex-backup",
            },
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const after = await Session.get(childID)
          const afterPrimary = await Session.get(primary.sessionID)
          expect((await childAtAbort.promise).cortex?.maintenance).toMatchObject({
            maintenanceID: lease.maintenanceID,
            admitted: true,
          })
          for (const [old, current] of [
            [before, after],
            [beforePrimary, afterPrimary],
          ]) {
            expect(current.cortex?.status).toBe("running")
            expect(current.cortex?.taskID).toBe(old.cortex?.taskID)
            expect(current.cortex?.rootID).toBe(old.cortex?.rootID)
            expect(current.cortex?.maintenance).toMatchObject({ maintenanceID: lease.maintenanceID, admitted: true })
            expect(current.cortex?.transfer).toBeUndefined()
            expect(SessionManager.isRunning(current.id)).toBeFalse()
          }
          expect(parentCalls).toBe(1)
          expect(childCalls).toBe(1)
          await RuntimeMaintenance.release(lease)
          expect(parentCalls).toBe(1)
          expect(childCalls).toBe(1)
          expect((await Session.get(childID)).cortex?.status).toBe("running")
          expect((await Session.get(primary.sessionID)).cortex?.status).toBe("running")
        } finally {
          clearTimeout(rescue)
          stopObserving()
        }
      },
    }),
  )
}, 20000)

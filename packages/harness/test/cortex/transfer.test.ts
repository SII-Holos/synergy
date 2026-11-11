import { expect, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { testRuntime } from "../support/runtime"

test("freezing a queued Cortex task preserves its identity, controls and parent delivery intent", async () => {
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_transfer_parent",
          agent: "developer",
          description: "Portable delegation",
          prompt: "Retain this task",
          executionRole: "delegated_subagent",
          output: { mode: "structured", schema: { type: "object" } },
          notifyParentOnComplete: true,
          maxOutputTokens: 1234,
          maxCost: 2,
          timeoutMs: 5000,
        })
        const before = (await Session.get(task.sessionID)).cortex!
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        await Cortex.suspendForTransfer(task.id, {
          handoffID: "handoff",
          rootSessionID: parent.id,
          signal: new AbortController().signal,
        })
        const after = (await Session.get(task.sessionID)).cortex!
        expect(after).toMatchObject({
          ...before,
          transfer: {
            version: 1,
            handoffID: "handoff",
            rootSessionID: parent.id,
            priorStatus: "queued",
            maxOutputTokens: 1234,
            maxCost: 2,
          },
        })
        await expect(Cortex.cancel(task.id)).rejects.toThrow("transfer")
        expect(await Cortex.start(task.id)).toBe(task)
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
        expect(await SessionInbox.list(parent.id)).toEqual([])
      },
    }),
  )
})

test("a running Cortex handoff resumes its recorded native root without resending the task", async () => {
  const { ProviderSdkSource } = await import("../../src/provider/sdk-source")
  const { SessionTransferEpochs: Epochs } = await import("../../src/session/transfer-epochs")
  const { SessionTransferOwners: Owners } = await import("../../src/session/transfer-owners")
  const { SessionManager } = await import("../../src/session/manager")
  const { simulateReadableStream } = await import("ai")
  const started = Promise.withResolvers<void>()
  let calls = 0
  const model: import("@ai-sdk/provider").LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "fixture",
    modelId: "child",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream(input) {
      calls++
      if (calls === 1) {
        started.resolve()
        await new Promise((_, reject) => {
          if (input.abortSignal?.aborted) reject(input.abortSignal.reason)
          else input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal!.reason), { once: true })
        })
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "result" },
            { type: "text-delta", id: "result", delta: "Preserved native root." },
            { type: "text-end", id: "result" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }
    },
  }
  const sdk: import("@ai-sdk/provider").ProviderV2 = {
    languageModel: (id) =>
      id === "child"
        ? model
        : {
            ...model,
            modelId: "auxiliary",
            async doStream() {
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: "text-start", id: "aux" },
                    { type: "text-delta", id: "aux", delta: "Fixture" },
                    { type: "text-end", id: "aux" },
                    {
                      type: "finish",
                      finishReason: "stop",
                      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    },
                  ],
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                }),
              }
            },
          },
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
        model: "fixture/child",
        nano_model: "fixture/auxiliary",
        mini_model: "fixture/auxiliary",
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
            models: {
              auxiliary: { id: "auxiliary", name: "Auxiliary", limit: { context: 128000, output: 8000 } },
              child: { id: "child", name: "Child", limit: { context: 128000, output: 8000 }, tool_call: true },
            },
          },
        },
        agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
      }),
    },
    register() {
      registerCortexSessionRuntime()
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.launch({
          parentSessionID: parent.id,
          parentMessageID: "msg_transfer_parent",
          agent: "fixture",
          description: "Paused delegation",
          prompt: "Do this exactly once.",
          executionRole: "delegated_subagent",
          output: { mode: "final_response" },
          notifyParentOnComplete: true,
          maxOutputTokens: 321,
          timeoutMs: 10000,
        })
        await started.promise
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        const binding = {
          scopeID: "home",
          sessionID: parent.id,
          handoffID: "running",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze(binding)
        const childBinding = { ...binding, sessionID: task.sessionID, rootSessionID: parent.id }
        const receipt = await Owners.freeze(
          {
            session: await Session.get(task.sessionID),
            rootSessionID: parent.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          },
          ["cortex"],
        )
        await Epochs.freeze(childBinding, { owner: receipt })
        const held = await Session.get(task.sessionID)
        expect(held.cortex?.status).toBe("running")
        expect(held.cortex?.transfer).toMatchObject({
          admitted: true,
          rootID: held.cortex!.rootID,
          maxOutputTokens: 321,
        })
        expect(SessionManager.isRunning(task.sessionID)).toBe(false)
        expect(await SessionInbox.list(parent.id)).toEqual([])
        await expect(Cortex.resumeTransferred(task.sessionID)).rejects.toThrow()
        Cortex.reset()
        const cold = await Owners.inspect(
          {
            session: await Session.get(task.sessionID),
            rootSessionID: parent.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          },
          ["cortex"],
        )
        expect(cold.requirements).toEqual([])
        await Epochs.cancel(binding)
        await Epochs.cancel(childBinding)
        await SessionLifecycle.clear(parent.id)
        await Owners.resume({
          session: await Session.get(parent.id),
          rootSessionID: parent.id,
          intentID: "trusted-continue",
          signal: new AbortController().signal,
        })
        await Cortex.drain(task.id)
        const after = await Session.get(task.sessionID)
        expect(after.cortex?.taskID).toBe(task.id)
        expect(after.cortex?.rootID).toBe(held.cortex?.rootID)
        expect(after.cortex?.status).toBe("completed")
        expect(after.cortex?.output).toEqual({ mode: "final_response", value: "Preserved native root." })
        expect(after.cortex?.transfer).toBeUndefined()
        const roots = (await Session.messages({ sessionID: task.sessionID })).filter(
          (message) => message.info.role === "user" && message.info.isRoot,
        )
        expect(roots.map((message) => message.info.id)).toEqual([held.cortex?.rootID])
        expect(calls).toBe(2)
        expect(
          (await SessionInbox.list(parent.id)).filter(
            (item) => item.deliveryKey === `cortex:taskNotification:${task.id}`,
          ),
        ).toHaveLength(1)
      },
    }),
  )
}, 20000)

test("an active cold Cortex delegation blocks portability rather than inferring completion", async () => {
  const { SessionTransferOwners: Owners } = await import("../../src/session/transfer-owners")
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_transfer_parent",
          agent: "developer",
          description: "Cold task",
          prompt: "Keep its original state",
          executionRole: "delegated_subagent",
        })
        Cortex.reset()
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        const context = {
          session: await Session.get(task.sessionID),
          rootSessionID: parent.id,
          handoffID: "cold",
          signal: new AbortController().signal,
        }
        expect((await Owners.inspect(context, ["cortex"])).requirements).toMatchObject([
          { code: "cortex_cold_active", recoverable: true },
        ])
        await expect(Owners.freeze(context, ["cortex"])).rejects.toThrow("live owner")
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
        expect(await SessionInbox.list(parent.id)).toEqual([])
      },
    }),
  )
})

test("native Cortex transfer migrations rebuild only derived indexes for proven holds", async () => {
  const { CortexTransferHolds, cortexTransferHoldMigration } = await import("../../src/cortex/transfer-holds")
  const { Storage } = await import("../../src/storage/storage")
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_transfer_parent",
          agent: "developer",
          description: "Indexed task",
          prompt: "Keep original controls",
          executionRole: "delegated_subagent",
          maxCost: 4,
        })
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        await Cortex.suspendForTransfer(task.id, {
          rootSessionID: parent.id,
          handoffID: "index",
          signal: new AbortController().signal,
        })
        const held = await Session.get(task.sessionID)
        await Storage.removeTree(["cortex_transfer_holds"])
        await cortexTransferHoldMigration.up(() => {})
        await cortexTransferHoldMigration.up(() => {})
        const rows = []
        for await (const row of CortexTransferHolds.list("home", parent.id)) rows.push(row)
        expect(rows).toEqual([{ sessionID: task.sessionID, version: 1, taskID: task.id, handoffID: "index" }])
        expect((await Session.get(task.sessionID)).cortex).toEqual(held.cortex)
      },
    }),
  )
})

test("a suspended structured repair admits its saved repair input without repeating the delegated task", async () => {
  const { ProviderSdkSource } = await import("../../src/provider/sdk-source")
  const { SessionExecutionSource } = await import("../../src/session/execution-source")
  const { SessionTransferEpochs: Epochs } = await import("../../src/session/transfer-epochs")
  const { SessionTransferOwners: Owners } = await import("../../src/session/transfer-owners")
  const { simulateReadableStream } = await import("ai")
  const admission = Promise.withResolvers<void>()
  let blocked = false
  let calls = 0
  const model: import("@ai-sdk/provider").LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "fixture",
    modelId: "child",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream() {
      calls++
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "result" },
            { type: "text-delta", id: "result", delta: calls === 1 ? "{}" : '"repaired"' },
            { type: "text-end", id: "result" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }
    },
  }
  const sdk: import("@ai-sdk/provider").ProviderV2 = {
    languageModel: () => model,
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
        model: "fixture/child",
        nano_model: "fixture/child",
        mini_model: "fixture/child",
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
            models: {
              child: { id: "child", name: "Child", limit: { context: 128000, output: 8000 }, tool_call: true },
            },
          },
        },
        agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
      }),
    },
    register() {
      registerCortexSessionRuntime()
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
      SessionExecutionSource.register({
        async authorize(input) {
          const session = await Session.get(input.sessionID)
          if (blocked || session.cortex?.repairTurns !== 1) return
          blocked = true
          admission.resolve()
          await new Promise((_, reject) => {
            if (input.signal?.aborted) reject(input.signal.reason)
            else input.signal?.addEventListener("abort", () => reject(input.signal!.reason), { once: true })
          })
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.launch({
          parentSessionID: parent.id,
          parentMessageID: "msg_transfer_parent",
          agent: "fixture",
          description: "Repair delegation",
          prompt: "Perform the delegated operation exactly once.",
          executionRole: "delegated_subagent",
          output: { mode: "structured", schema: { type: "string" }, maxRepairTurns: 1 },
          notifyParentOnComplete: false,
        })
        await admission.promise
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        const binding = {
          scopeID: "home",
          sessionID: parent.id,
          handoffID: "repair",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const childBinding = { ...binding, sessionID: task.sessionID, rootSessionID: parent.id }
        await Epochs.beginSource(binding)
        await Epochs.beginSource(childBinding)
        const receipt = await Owners.freeze(
          {
            session: await Session.get(task.sessionID),
            rootSessionID: parent.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          },
          ["cortex"],
        )
        await Epochs.freeze(binding)
        await Epochs.freeze(childBinding, { owner: receipt })
        expect((await Session.get(task.sessionID)).cortex?.transfer?.admitted).toBe(false)
        Cortex.reset()
        await Epochs.cancel(binding)
        await Epochs.cancel(childBinding)
        await SessionLifecycle.clear(parent.id)
        await Owners.resume({
          session: await Session.get(parent.id),
          rootSessionID: parent.id,
          intentID: "repair-continue",
          signal: new AbortController().signal,
        })
        await Cortex.drain(task.id)
        const roots = (await Session.messages({ sessionID: task.sessionID })).filter(
          (message) => message.info.role === "user" && message.info.isRoot,
        )
        const repair = roots
          .at(-1)!
          .parts.filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
        expect(roots).toHaveLength(2)
        expect(repair).toContain("Repair attempt 1 of 1")
        expect(repair).not.toContain("Perform the delegated operation exactly once.")
        expect((await Session.get(task.sessionID)).cortex).toMatchObject({
          status: "completed",
          output: { mode: "structured", value: "repaired" },
          repairTurns: 1,
        })
      },
    }),
  )
}, 20000)

test("Cortex private staging binds canonical data independently of serialized object key order", async () => {
  const { SessionTransferEpochs: Epochs } = await import("../../src/session/transfer-epochs")
  const { SessionTransferOwners: Owners } = await import("../../src/session/transfer-owners")
  const { SessionTransferStream: Stream } = await import("../../src/session/transfer-stream")
  const { SessionTransferStaging: Staging } = await import("../../src/session/transfer-staging")
  const { tmpdir } = await import("../support/fixture")
  const path = await import("node:path")
  await using directory = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximum: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximum) throw new Error("Oversized fixture object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime({ register: registerCortexSessionRuntime })
  const data = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: root.id,
          parentMessageID: "msg_original",
          agent: "developer",
          description: "Immutable canonical proof",
          prompt: "Keep original task",
          executionRole: "delegated_subagent",
        })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "proof",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const child = { ...binding, sessionID: task.sessionID, rootSessionID: root.id }
        await Epochs.beginSource(binding)
        await Epochs.beginSource(child)
        const context = {
          session: await Session.get(task.sessionID),
          rootSessionID: root.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        const receipt = await Owners.freeze(context, ["cortex"])
        await Epochs.freeze(binding)
        await Epochs.freeze(child, { owner: receipt })
        const session = await Session.get(task.sessionID)
        const stream = await Stream.write({
          store,
          owners: { cortex: 1 },
          entries: Owners.entries(context, ["cortex"]),
        })
        return { session, rootSessionID: root.id, stream }
      },
    }),
  )
  await using target = await testRuntime({ register: registerCortexSessionRuntime })
  await target.run(async () => {
    await Staging.receive({ handoffID: "proof", root: data.stream, store })
    const session = structuredClone(data.session)
    session.cortex = Object.fromEntries(Object.entries(session.cortex!).reverse()) as typeof session.cortex
    const context = await Staging.context({
      handoffID: "proof",
      ownerID: "cortex",
      session,
      rootSessionID: data.rootSessionID,
      mapping: {},
      signal: new AbortController().signal,
    })
    await expect(Owners.validate("cortex", context)).resolves.toBeUndefined()
    const changed = structuredClone(session)
    changed.cortex!.description = "Changed canonical content"
    const tampered = await Staging.context({
      handoffID: "proof",
      ownerID: "cortex",
      session: changed,
      rootSessionID: data.rootSessionID,
      mapping: {},
      signal: new AbortController().signal,
    })
    await expect(Owners.validate("cortex", tampered)).rejects.toThrow("changed")
  })
}, 20000)

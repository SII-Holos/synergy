import { expect, spyOn, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { testRuntime } from "../support/runtime"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { SessionManager } from "../../src/session/manager"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { CortexMaintenanceHolds, cortexMaintenanceHoldMigration } from "../../src/cortex/maintenance-holds"
import { Storage } from "../../src/storage/storage"
import { simulateReadableStream } from "ai"

const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "backup-one",
}

test.each([false, true])(
  "a draining transfer is not a native Cortex freeze proof during maintenance (cold=%s)",
  async (cold) => {
    await using runtime = await testRuntime({
      register() {
        registerCortexSessionRuntime()
        RuntimeMaintenance.configure({ required: ["cortex"] })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const parent = await Session.create({ workspace: null })
          const task = await Cortex.prepare({
            parentSessionID: parent.id,
            parentMessageID: "msg_transferring",
            agent: "developer",
            description: "Incomplete physical freeze",
            prompt: "Retain the actual task",
          })
          await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
          const binding = {
            sessionID: task.sessionID,
            rootSessionID: parent.id,
            scopeID: "home",
            handoffID: "draining-transfer",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.beginSource(binding)
          await Cortex.suspendForTransfer(task.id, {
            sessionID: task.sessionID,
            rootSessionID: parent.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          })
          if (cold) Cortex.reset()
          expect(await Epochs.isFrozen(task.sessionID)).toBeTrue()
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: actor.requestID,
            actor,
          })
          await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("handoff")
          expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
          expect((await Session.get(task.sessionID)).cortex?.maintenance).toBeUndefined()
          expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
        },
      }),
    )
  },
)

test.each(["frozen", "surrendered"] as const)(
  "an exact %s source proof retains its independent Cortex transfer hold through maintenance",
  async (phase) => {
    await using runtime = await testRuntime({
      register() {
        registerCortexSessionRuntime()
        RuntimeMaintenance.configure({ required: ["cortex"] })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const parent = await Session.create({ workspace: null })
          const task = await Cortex.prepare({
            parentSessionID: parent.id,
            parentMessageID: "msg_frozen_transfer",
            agent: "developer",
            description: "Retained physical proof",
            prompt: "Do not change ownership",
          })
          await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
          const binding = {
            sessionID: task.sessionID,
            rootSessionID: parent.id,
            scopeID: "home",
            handoffID: "final-transfer",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.beginSource(binding)
          const receipt = await Owners.freeze(
            {
              session: await Session.get(task.sessionID),
              rootSessionID: parent.id,
              handoffID: binding.handoffID,
              signal: new AbortController().signal,
            },
            ["cortex"],
          )
          await Epochs.freeze(binding, { owner: receipt })
          if (phase === "surrendered") {
            await Epochs.seal(binding, "a".repeat(64))
            await Epochs.surrender(binding, "b".repeat(64))
          }
          Cortex.reset()
          const before = (await Session.get(task.sessionID)).cortex
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: actor.requestID,
            actor,
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          await RuntimeMaintenance.release(lease)
          expect((await Epochs.inspect(binding)).phase).toBe(phase)
          expect((await Session.get(task.sessionID)).cortex).toEqual(before)
          await expect(
            Epochs.assertOwnerResume({
              sessionID: task.sessionID,
              rootSessionID: parent.id,
              handoffID: binding.handoffID,
            }),
          ).rejects.toThrow()
        },
      }),
    )
  },
)

test("native maintenance preserves queued Cortex controls without pausing its parent or inventing transfer authority", async () => {
  await using runtime = await testRuntime({
    register() {
      registerCortexSessionRuntime()
      RuntimeMaintenance.configure({ required: ["cortex"] })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_maintenance_parent",
          agent: "developer",
          description: "Retained native delegation",
          prompt: "Execute this task exactly once",
          executionRole: "delegated_subagent",
          output: { mode: "structured", schema: { type: "object" } },
          maxOutputTokens: 123,
          maxCost: 2,
          timeoutMs: 5000,
          notifyParentOnComplete: true,
        })
        const before = (await Session.get(task.sessionID)).cortex!
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: actor.requestID,
          actor,
        })
        const receipt = await RuntimeMaintenance.drain(lease)
        const after = await Session.get(task.sessionID)
        expect(after.cortex).toMatchObject({
          ...before,
          maintenance: {
            version: 1,
            maintenanceID: lease.maintenanceID,
            purpose: "organization-backup",
            priorStatus: "queued",
            admitted: false,
            maxOutputTokens: 123,
            maxCost: 2,
          },
        })
        expect(after.cortex?.transfer).toBeUndefined()
        expect((await Session.get(parent.id)).paused).toBeUndefined()
        await expect(Cortex.cancel(task.id)).rejects.toThrow("maintenance")
        expect(await Cortex.start(task.id)).toBe(task)
        await RuntimeMaintenance.freeze(lease, receipt)
        await RuntimeMaintenance.release(lease)
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
        expect((await Session.get(task.sessionID)).cortex?.maintenance?.releasedAt).toBeNumber()
        expect(await SessionInbox.list(parent.id)).toEqual([])
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        await Cortex.suspendForTransfer(task.id, {
          sessionID: task.sessionID,
          rootSessionID: parent.id,
          handoffID: "after-backup",
          signal: new AbortController().signal,
        })
        expect((await Session.get(task.sessionID)).cortex?.maintenance).toBeUndefined()
        expect((await Session.get(task.sessionID)).cortex?.transfer?.handoffID).toBe("after-backup")
      },
    }),
  )
})

test("an active cold Cortex writer remains a maintenance requirement rather than becoming cancelled or implicitly unlimited", async () => {
  await using runtime = await testRuntime({
    register() {
      registerCortexSessionRuntime()
      RuntimeMaintenance.configure({ required: ["cortex"] })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_cold_parent",
          agent: "developer",
          description: "Cold task",
          prompt: "Do not reconstruct this task",
          maxOutputTokens: 123,
        })
        Cortex.reset()
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: actor.requestID,
          actor,
        })
        await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("Cortex")
        expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
        expect((await Session.get(task.sessionID)).cortex?.maintenance).toBeUndefined()
        expect(await SessionInbox.list(parent.id)).toEqual([])
        const key = ["sessions", "home", task.sessionID, "info"]
        const raw = await Storage.read<{ cortex: Record<string, unknown> }>(key)
        await Storage.write(key, { ...raw, cortex: { ...raw.cortex, status: "future-active" } })
        await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("unknown Cortex status")
        expect((await Storage.read<{ cortex: { status: string } }>(key)).cortex.status).toBe("future-active")
      },
    }),
  )
})

test("the owning Cortex maintenance migration rebuilds only exact derived holds and retains unknown schemas", async () => {
  await using runtime = await testRuntime({
    register() {
      registerCortexSessionRuntime()
      RuntimeMaintenance.configure({ required: ["cortex"] })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_migrating",
          agent: "developer",
          description: "Retain the hold",
          prompt: "Do not rewrite",
          maxCost: 2,
        })
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: actor.requestID,
          actor,
        })
        await RuntimeMaintenance.drain(lease)
        const before = await Session.get(task.sessionID)
        await Storage.removeTree(["cortex_maintenance_holds"])
        await cortexMaintenanceHoldMigration.up(() => {})
        await cortexMaintenanceHoldMigration.up(() => {})
        const rows = []
        for await (const row of CortexMaintenanceHolds.list(lease.maintenanceID)) rows.push(row)
        expect(rows).toEqual([{ sessionID: task.sessionID, version: 1, taskID: task.id, scopeID: "home" }])
        expect((await Session.get(task.sessionID)).cortex).toEqual(before.cortex)
        const key = ["sessions", "home", task.sessionID, "info"]
        const raw = await Storage.read<Record<string, unknown>>(key)
        const cortex = before.cortex
        if (!cortex?.maintenance) throw new Error("The native maintenance hold is missing")
        await Storage.write(key, {
          ...raw,
          cortex: { ...cortex, maintenance: { ...cortex.maintenance, version: 999 } },
        })
        await expect(cortexMaintenanceHoldMigration.up(() => {})).rejects.toThrow()
        expect(
          (await Storage.read<{ cortex: { maintenance: { version: number } } }>(key)).cortex.maintenance.version,
        ).toBe(999)
        Cortex.reset()
      },
    }),
  )
})

test("maintaining a running native Cortex task drains its model and resumes the original root only after explicit source admission", async () => {
  let started = Promise.withResolvers<void>()
  let blockOnCall = 1
  const requests: Array<number | undefined> = []
  const model: import("@ai-sdk/provider").LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "fixture",
    modelId: "child",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream(input) {
      requests.push(input.maxOutputTokens)
      if (requests.length === blockOnCall) {
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
            { type: "text-delta", id: "result", delta: "Retained maintenance continuation." },
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
      RuntimeMaintenance.configure({ required: ["cortex"] })
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
          parentMessageID: "msg_running_parent",
          agent: "fixture",
          description: "Running native task",
          prompt: "Execute this request exactly once.",
          executionRole: "delegated_subagent",
          output: { mode: "final_response" },
          notifyParentOnComplete: true,
          maxOutputTokens: 321,
          timeoutMs: 20000,
        })
        await started.promise
        const before = await Session.get(task.sessionID)
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: actor.requestID,
          actor,
        })
        const receipt = await RuntimeMaintenance.drain(lease)
        const held = await Session.get(task.sessionID)
        expect(held.cortex?.rootID).toBe(before.cortex?.rootID)
        expect(held.cortex?.status).toBe("running")
        expect(held.cortex?.maintenance).toMatchObject({
          admitted: true,
          rootID: before.cortex?.rootID,
          maxOutputTokens: 321,
        })
        expect(SessionManager.isRunning(task.sessionID)).toBe(false)
        expect((await Session.get(parent.id)).paused).toBeUndefined()
        await RuntimeMaintenance.freeze(lease, receipt)
        expect(await Cortex.start(task.id)).toBe(task)
        expect(requests).toEqual([321])
        await RuntimeMaintenance.release(lease)
        expect(requests).toEqual([321])
        expect(await SessionInbox.list(parent.id)).toEqual([])
        await Cortex.start(task.id)
        await Cortex.drain(task.id)
        const after = await Session.get(task.sessionID)
        expect(after.cortex?.taskID).toBe(task.id)
        expect(after.cortex?.rootID).toBe(before.cortex?.rootID)
        expect(after.cortex?.status).toBe("completed")
        expect(after.cortex?.maintenance).toBeUndefined()
        const roots = (await Session.messages({ sessionID: task.sessionID })).filter(
          (message) => message.info.role === "user" && message.info.isRoot,
        )
        const rootID = before.cortex?.rootID
        if (!rootID) throw new Error("The admitted Cortex task lost its native root")
        expect(roots.map((message) => message.info.id)).toEqual([rootID])
        expect(requests).toEqual([321, 321])
        expect(
          (await SessionInbox.list(parent.id)).filter(
            (item) => item.deliveryKey === `cortex:taskNotification:${task.id}`,
          ),
        ).toHaveLength(1)
        started = Promise.withResolvers<void>()
        blockOnCall = 3
        const expiring = await Cortex.launch({
          parentSessionID: parent.id,
          parentMessageID: "msg_expiring_parent",
          agent: "fixture",
          description: "Retain the original deadline",
          prompt: "This task must not restart after its deadline",
          output: { mode: "final_response" },
          maxOutputTokens: 99,
          timeoutMs: 20000,
        })
        await started.promise
        const requestID = "backup-expiring"
        const second = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID,
          actor: { ...actor, requestID },
        })
        await RuntimeMaintenance.freeze(second, await RuntimeMaintenance.drain(second))
        const deadlineAt = (await Session.get(expiring.sessionID)).cortex?.maintenance?.deadlineAt
        if (!deadlineAt) throw new Error("The running task lost its native deadline")
        await RuntimeMaintenance.release(second)
        const clock = spyOn(Date, "now").mockReturnValue(deadlineAt + 1)
        try {
          await Cortex.start(expiring.id)
          await Cortex.drain(expiring.id)
          expect(requests).toEqual([321, 321, 99])
          expect((await Session.get(expiring.sessionID)).cortex?.status).toBe("error")
        } finally {
          clock.mockRestore()
        }
      },
    }),
  )
}, 20000)

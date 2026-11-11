import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { Storage } from "../../src/storage/storage"
import { Lock } from "../../src/util/lock"

function objectStore() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximumBytes: number) {
      const value = values.get(hash)
      if (!value || value.byteLength > maximumBytes) throw new Error("Missing or oversized object")
      return value.slice()
    },
  }
}

test("source preparation abandons an aborted lock waiter before the current source releases its lock", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "source-queued-cancel",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const held = await Lock.write("session-transfer-source:" + root.id)
        const controller = new AbortController()
        const reason = new Error("Queued source preparation cancelled")
        const observed = Promise.withResolvers<{ kind: "settled"; error: unknown } | { kind: "waiting" }>()
        const work = Source.prepare({
          binding,
          store: objectStore(),
          signal: controller.signal,
          async verify() {},
        }).then(
          () => {
            observed.resolve({ kind: "settled", error: undefined })
          },
          (error) => {
            observed.resolve({ kind: "settled", error })
          },
        )
        const rescue = setTimeout(() => observed.resolve({ kind: "waiting" }), 1000)
        try {
          controller.abort(reason)
          const outcome = await observed.promise
          expect(outcome.kind).toBe("settled")
          if (outcome.kind !== "settled") throw new Error("Source stayed queued after cancellation")
          expect(outcome.error).toBe(reason)
          expect((await Session.get(root.id)).paused).toBeUndefined()
          expect(await Source.status(binding)).toBeUndefined()
        } finally {
          clearTimeout(rescue)
          held[Symbol.dispose]()
          await work
        }
      },
    }),
  )
}, 15000)

test("source drains every native owner before freezing child-to-root and seals late native children", async () => {
  let rootID = ""
  let childID = ""
  let lateID = ""
  let nativeDrains = 0
  await using runtime = await testRuntime({
    register() {
      Core.register()
      Owners.register("test-native", {
        version: 1,
        reads: [1],
        applies: (session) => SessionInteraction.isUnattended(session.interaction),
        async inspect() {
          return { requirements: [], children: (async function* () {})() }
        },
        async freeze(context) {
          expect(
            (
              await Epochs.inspect(
                await Epochs.ownerPreparationBinding({ sessionID: rootID, handoffID: context.handoffID }),
              )
            ).phase,
          ).toBe("draining")
          expect(
            (
              await Epochs.inspect(
                await Epochs.ownerPreparationBinding({ sessionID: childID, handoffID: context.handoffID }),
              )
            ).phase,
          ).toBe("draining")
          await Session.update(rootID, (draft) => {
            draft.title = "Native continuation drained"
          })
          if (!lateID) lateID = (await Session.create({ parentID: childID, workspaceID: null, environmentID: null })).id
          expect(await Epochs.isFrozen(lateID)).toBe(true)
          nativeDrains++
        },
        async *export() {},
        async validate() {},
        async publish() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        rootID = root.id
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        childID = child.id
        const internal = await Session.create({
          parentID: child.id,
          interaction: SessionInteraction.unattended("native-fixture"),
          workspaceID: null,
          environmentID: null,
        })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "source-controller",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const store = objectStore()
        let barriers = 0
        const prepared = await Source.prepare({
          binding,
          store,
          signal: new AbortController().signal,
          async verify() {
            barriers++
          },
        })
        expect(barriers).toBeGreaterThanOrEqual(2)
        expect(nativeDrains).toBeGreaterThan(0)
        expect(prepared.members).toBe(4)
        expect(prepared.manifestHash).toBe(Stream.digest(prepared.root))
        const infoIDs: string[] = []
        await using directory = await tmpdir()
        await using reader = await Stream.open({ root: prepared.root, store, directory: directory.path })
        for await (const entry of reader.entries()) {
          if (
            entry.metadata.key &&
            Array.isArray(entry.metadata.key) &&
            entry.metadata.key.at(-1) === "info" &&
            entry.metadata.key.length === 4
          )
            infoIDs.push(String(entry.metadata.key[2]))
          for await (const _ of entry.content) {
          }
        }
        expect(infoIDs.sort()).toEqual([root.id, child.id, internal.id, lateID].sort())
        for (const id of infoIDs) {
          await Epochs.assertFrozen(id, binding.handoffID)
          expect(
            (await Epochs.inspect({ ...binding, sessionID: id, ...(id !== root.id ? { rootSessionID: root.id } : {}) }))
              .manifestHash,
          ).toBe(prepared.manifestHash)
        }
        expect((await Session.get(root.id)).title).toBe("Native continuation drained")
        expect((await Session.get(internal.id)).paused).toBeUndefined()
        expect((await Session.get(lateID)).paused).toBeDefined()
        await expect(Session.create({ parentID: root.id, workspaceID: null })).rejects.toThrow()
        const again = await Source.prepare({ binding, store, signal: new AbortController().signal, async verify() {} })
        expect(again).toEqual(prepared)
      },
    }),
  )
}, 15000)

test("source with a changed command barrier remains held without publishing a package or executing recovery", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "source-raced-command",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let barriers = 0
        await expect(
          Source.prepare({
            binding,
            store: objectStore(),
            signal: new AbortController().signal,
            async verify() {
              if (++barriers > 1) throw new Error("Command checkpoint changed")
            },
          }),
        ).rejects.toThrow("Command checkpoint changed")
        expect((await Epochs.inspect(binding)).phase).toBe("draining")
        expect((await Session.get(root.id)).paused).toBeDefined()
        expect(await Source.status(binding)).toBeUndefined()
        expect(await Epochs.isFrozen(root.id)).toBe(true)
      },
    }),
  )
}, 15000)

test("source rejects membership created after drainage before publishing its final root fence", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "source-raced-child",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let barriers = 0
        let lateID = ""
        await expect(
          Source.prepare({
            binding,
            store: objectStore(),
            signal: new AbortController().signal,
            async verify() {
              if (++barriers === 2)
                lateID = (await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })).id
            },
          }),
        ).rejects.toThrow("membership changed")
        expect((await Epochs.inspect(binding)).phase).toBe("draining")
        expect(await Epochs.isFrozen(lateID)).toBe(true)
        expect(await Source.status(binding)).toBeUndefined()
        const recovered = await Source.prepare({
          binding,
          store: objectStore(),
          signal: new AbortController().signal,
          async verify() {},
        })
        expect(recovered.members).toBe(2)
        expect((await Session.get(lateID)).paused).toBeDefined()
        await Epochs.cancel({ ...binding, sessionID: lateID, rootSessionID: root.id })
        await expect(
          Storage.write(["sessions", root.scope.id, lateID, "native-tail"], { value: "late" }),
        ).rejects.toThrow("frozen")
      },
    }),
  )
}, 15000)

test("source coordinates the actual Cortex owner without cancelling or recreating its queued task", async () => {
  await using runtime = await testRuntime({
    register() {
      Core.register()
      registerCortexSessionRuntime()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const task = await Cortex.prepare({
          parentSessionID: root.id,
          parentMessageID: "msg_native_parent",
          agent: "developer",
          description: "Portable native child",
          prompt: "Keep the original input",
          executionRole: "delegated_subagent",
          output: { mode: "final_response" },
          notifyParentOnComplete: true,
          maxOutputTokens: 432,
          timeoutMs: 5000,
        })
        const before = (await Session.get(task.sessionID)).cortex
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "source-cortex",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding,
          store: objectStore(),
          signal: new AbortController().signal,
          async verify() {},
        })
        expect(prepared.members).toBe(2)
        const after = (await Session.get(task.sessionID)).cortex
        expect(after).toMatchObject({
          ...before,
          transfer: {
            handoffID: binding.handoffID,
            rootSessionID: root.id,
            priorStatus: "queued",
            maxOutputTokens: 432,
          },
        })
        expect((await Session.get(task.sessionID)).paused).toBeUndefined()
        expect((await Session.messages({ sessionID: task.sessionID })).length).toBe(0)
        await expect(Cortex.cancel(task.id)).rejects.toThrow("transfer")
        expect((await Source.status(binding))?.closureHash).toBe(prepared.closureHash)
      },
    }),
  )
}, 15000)

test("source reconciles a complete candidate after interruption without exporting its frozen body again", async () => {
  await using directory = await tmpdir()
  let runtime = await testRuntime({ home: directory.path, register: Core.register })
  const store = objectStore()
  try {
    const binding = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: root.scope.id,
            handoffID: "source-candidate",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await expect(
            Source.prepare({
              binding,
              store,
              signal: new AbortController().signal,
              async verify() {
                const [candidate] = await Storage.readMany([
                  ["session_transfer_source", binding.handoffID, binding.sessionID, "candidate"],
                ])
                if (candidate !== undefined) throw new Error("Connection lost after capture")
              },
            }),
          ).rejects.toThrow("Connection lost after capture")
          expect(await Source.status(binding)).toBeUndefined()
          await Epochs.assertFrozen(child.id, binding.handoffID)
          expect((await Epochs.inspect(binding)).manifestHash).toBeUndefined()
          return binding
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: directory.path, register: Core.register })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const result = await Source.prepare({
            binding,
            store: {
              get: store.get,
              async put() {
                throw new Error("Frozen body was exported again")
              },
            },
            signal: new AbortController().signal,
            async verify() {},
          })
          expect(result.members).toBe(2)
          expect(await Source.status(binding)).toEqual(result)
          expect((await Session.get(binding.sessionID)).paused).toBeDefined()
        },
      }),
    )
  } finally {
    await runtime.close()
  }
}, 15000)

import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"

function objects() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string) {
      const bytes = values.get(hash)
      if (!bytes) throw new Error("Captured object is unavailable")
      return bytes.slice()
    },
  }
}

test("aggregate surrender commits every frozen member and the exact preparation receipt together across failure and restart", async () => {
  await using home = await tmpdir()
  let rejectReceipt = true
  const failed = new Error("The aggregate surrender receipt did not commit")
  const register = () => {
    Core.register()
    StorageMutationGuard.register("surrender-receipt-fault", async (_tx, keys) => {
      if (rejectReceipt && keys.some((key) => key[0] === "session_transfer_source" && key[3] === "surrendered"))
        throw failed
    })
  }
  let runtime = await testRuntime({ home: home.path, register })
  try {
    const captured = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: root.scope.id,
            handoffID: "surrendered-cohort",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const childBinding = { ...binding, sessionID: child.id, rootSessionID: root.id }
          const prepared = await Source.prepare({
            binding,
            store: objects(),
            signal: new AbortController().signal,
            async verify() {},
          })
          const request = {
            binding,
            manifestHash: prepared.manifestHash,
            preparedHash: "b".repeat(64),
            signal: new AbortController().signal,
            async verify() {},
          }
          await expect(Source.surrender(request)).rejects.toBe(failed)
          expect((await Epochs.inspect(binding)).phase).toBe("frozen")
          expect((await Epochs.inspect(childBinding)).phase).toBe("frozen")
          expect(await Source.surrendered(binding)).toBeUndefined()
          rejectReceipt = false
          await expect(Source.surrender({ ...request, manifestHash: "c".repeat(64) })).rejects.toThrow()
          const receipt = await Source.surrender(request)
          expect(receipt).toMatchObject({
            binding,
            manifestHash: prepared.manifestHash,
            preparedHash: request.preparedHash,
            members: 2,
          })
          expect((await Epochs.inspect(binding)).phase).toBe("surrendered")
          expect((await Epochs.inspect(childBinding)).phase).toBe("surrendered")
          await expect(
            Source.cancel({ binding, store: objects(), signal: request.signal, async verify() {} }),
          ).rejects.toThrow()
          await expect(Source.surrender({ ...request, preparedHash: "c".repeat(64) })).rejects.toThrow()
          expect(await Source.surrender(request)).toEqual(receipt)
          return { request, receipt, childBinding }
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: home.path, register })
    await runtime.run(async () => {
      expect(await Source.surrendered(captured.request.binding)).toEqual(captured.receipt)
      expect(await Source.surrender(captured.request)).toEqual(captured.receipt)
      expect((await Epochs.inspect(captured.childBinding)).phase).toBe("surrendered")
    })
  } finally {
    await runtime.close()
  }
}, 15000)

test("a cancelled descendant prevents aggregate surrender without changing any remaining frozen member", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "partly-cancelled-cohort",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const childBinding = { ...binding, sessionID: child.id, rootSessionID: root.id }
        const prepared = await Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {},
        })
        await Epochs.cancel(childBinding)
        await expect(
          Source.surrender({
            binding,
            manifestHash: prepared.manifestHash,
            preparedHash: "d".repeat(64),
            signal: new AbortController().signal,
            async verify() {},
          }),
        ).rejects.toThrow()
        expect((await Epochs.inspect(binding)).phase).toBe("frozen")
        expect((await Epochs.inspect(childBinding)).phase).toBe("cancelled")
        expect(await Source.surrendered(binding)).toBeUndefined()
      },
    }),
  )
})

test("aggregate surrender fixes its package, preparation and verifier before asynchronous member writes", async () => {
  let mutate: (() => void) | undefined
  await using runtime = await testRuntime({
    register() {
      Core.register()
      StorageMutationGuard.register("surrender-input-mutation", async (_tx, keys) => {
        if (!keys.some((key) => key[0] === "session_transfer_epochs")) return
        const selected = mutate
        mutate = undefined
        selected?.()
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "immutable-surrender-input",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {},
        })
        let verifications = 0
        let replacements = 0
        const preparedHash = "a".repeat(64)
        const request = {
          binding,
          manifestHash: prepared.manifestHash,
          preparedHash,
          signal: new AbortController().signal,
          async verify() {
            verifications++
          },
        }
        mutate = () => {
          request.manifestHash = "c".repeat(64)
          request.preparedHash = "b".repeat(64)
          request.verify = async () => {
            replacements++
          }
        }
        const receipt = await Source.surrender(request)
        const members = await Promise.all([
          Epochs.inspect(binding),
          Epochs.inspect({ ...binding, sessionID: child.id, rootSessionID: root.id }),
        ])
        expect({
          manifestHash: receipt.manifestHash,
          preparedHash: receipt.preparedHash,
          memberHashes: members.map((member) => member.preparedHash),
          verifications,
          replacements,
        }).toEqual({
          manifestHash: prepared.manifestHash,
          preparedHash,
          memberHashes: [preparedHash, preparedHash],
          verifications: 2,
          replacements: 0,
        })
        expect(await Source.surrendered(binding)).toEqual(receipt)
      },
    }),
  )
})

test("replacing a surrender request's signal cannot suppress its original cancellation", async () => {
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
          handoffID: "immutable-surrender-cancellation",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding,
          store: objects(),
          signal: new AbortController().signal,
          async verify() {},
        })
        const controller = new AbortController()
        const reason = new Error("The admitted surrender was cancelled")
        const request = {
          binding,
          manifestHash: prepared.manifestHash,
          preparedHash: "a".repeat(64),
          signal: controller.signal,
          async verify() {
            request.signal = new AbortController().signal
            controller.abort(reason)
          },
        }
        await expect(Source.surrender(request)).rejects.toBe(reason)
        expect((await Epochs.inspect(binding)).phase).toBe("frozen")
        expect(await Source.surrendered(binding)).toBeUndefined()
      },
    }),
  )
})

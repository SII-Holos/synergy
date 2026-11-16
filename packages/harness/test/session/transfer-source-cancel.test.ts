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

test("source cancellation repairs a partially indexed cohort and commits every cancelled epoch with one durable receipt", async () => {
  await using directory = await tmpdir()
  let childID = ""
  let failMember = true
  let failCancellation = true
  const memberFailure = new Error("Source stopped after admitting a child's intent")
  const cancellationFailure = new Error("Cancellation receipt could not commit")
  const register = () => {
    Core.register()
    StorageMutationGuard.register("source-cancel-faults", async (_tx, keys) => {
      if (
        failMember &&
        keys.some((key) => key[0] === "session_transfer_source" && key[3] === "members" && key[4] === childID)
      )
        throw memberFailure
      if (failCancellation && keys.some((key) => key[0] === "session_transfer_source" && key[3] === "cancelled"))
        throw cancellationFailure
    })
  }
  const values = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string) {
      const bytes = values.get(hash)
      if (!bytes) throw new Error("No captured object")
      return bytes.slice()
    },
  }
  let runtime = await testRuntime({ home: directory.path, register })
  try {
    const captured = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          childID = child.id
          const binding = {
            sessionID: root.id,
            scopeID: root.scope.id,
            handoffID: "cancel-complete-cohort",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const childBinding = { ...binding, sessionID: child.id, rootSessionID: root.id }
          await expect(
            Source.prepare({ binding, store, signal: new AbortController().signal, async verify() {} }),
          ).rejects.toBe(memberFailure)
          await expect(Epochs.inspect(childBinding)).rejects.toThrow("unavailable")
          await Epochs.beginSource(childBinding)
          expect((await Epochs.inspect(childBinding)).phase).toBe("draining")
          const initial: string[] = []
          for await (const member of Source.members(binding)) initial.push(member.binding.sessionID)
          expect(initial).toEqual([root.id])
          failMember = false
          const cancel = () =>
            Source.cancel({ binding, store, signal: new AbortController().signal, async verify() {} })
          await expect(cancel()).rejects.toBe(cancellationFailure)
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
          expect((await Epochs.inspect(childBinding)).phase).toBe("draining")
          expect(await Source.cancellation(binding)).toBeUndefined()
          expect(values.size).toBe(0)
          failCancellation = false
          const cancelled = await cancel()
          expect(cancelled).toMatchObject({ binding, manifestHash: null, members: 2 })
          expect((await Epochs.inspect(binding)).phase).toBe("cancelled")
          expect((await Epochs.inspect(childBinding)).phase).toBe("cancelled")
          expect((await Session.get(root.id)).paused).toBeDefined()
          expect((await Session.get(child.id)).paused).toBeDefined()
          expect(await cancel()).toEqual(cancelled)
          expect(values.size).toBe(0)
          return { binding, childBinding, cancelled }
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: directory.path, register })
    await runtime.run(async () => {
      expect(await Source.cancellation(captured.binding)).toEqual(captured.cancelled)
      expect(
        await Source.cancel({
          binding: captured.binding,
          store,
          signal: new AbortController().signal,
          async verify() {},
        }),
      ).toEqual(captured.cancelled)
      expect((await Epochs.inspect(captured.childBinding)).phase).toBe("cancelled")
    })
  } finally {
    await runtime.close()
  }
}, 15000)

test("a surrendered cohort member prevents cancellation from releasing any remaining source epoch", async () => {
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
          handoffID: "surrendered-member",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const childBinding = { ...binding, sessionID: child.id, rootSessionID: root.id }
        const values = new Map<string, Uint8Array>()
        const store = {
          async put(hash: string, bytes: Uint8Array) {
            values.set(hash, bytes.slice())
          },
          async get(hash: string) {
            const bytes = values.get(hash)
            if (!bytes) throw new Error("Missing native object")
            return bytes.slice()
          },
        }
        await Source.prepare({ binding, store, signal: new AbortController().signal, async verify() {} })
        await Epochs.surrender(childBinding, "a".repeat(64))
        await expect(
          Source.cancel({ binding, store, signal: new AbortController().signal, async verify() {} }),
        ).rejects.toThrow("surrender")
        expect((await Epochs.inspect(binding)).phase).toBe("frozen")
        expect((await Epochs.inspect(childBinding)).phase).toBe("surrendered")
        expect(await Source.cancellation(binding)).toBeUndefined()
      },
    }),
  )
})

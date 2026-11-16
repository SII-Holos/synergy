import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

test.each(["cancelled", "surrendered"] as const)(
  "retained Source %s receipts reopen their original binding without a caller Scope",
  async (kind) => {
    await using directory = await tmpdir()
    const home = path.join(directory.path, "original")
    await using original = await testRuntime({ home, register: Core.register })
    const binding = await original.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const binding = {
            sessionID: root.id,
            scopeID: root.scope.id,
            handoffID: "retained-source-" + kind,
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const values = new Map<string, Uint8Array>()
          const store = {
            async put(hash: string, bytes: Uint8Array) {
              values.set(hash, Uint8Array.from(bytes))
            },
            async get(hash: string, maximumBytes: number) {
              const bytes = values.get(hash)
              if (!bytes || bytes.byteLength > maximumBytes) throw new Error("Missing fixture object")
              return Uint8Array.from(bytes)
            },
          }
          const signal = new AbortController().signal
          const prepared = await Source.prepare({ binding, store, signal, async verify() {} })
          const selector = { sessionID: root.id, handoffID: binding.handoffID }
          expect(await Source.retainedReceipt(selector)).toBeUndefined()
          if (kind === "cancelled") await Source.cancel({ binding, store, signal, async verify() {} })
          else
            await Source.surrender({
              binding,
              manifestHash: prepared.manifestHash,
              preparedHash: "a".repeat(64),
              signal,
              async verify() {},
            })
          return binding
        },
      }),
    )
    await original.close()
    await using cold = await testRuntime({ home, register: Core.register })
    await cold.run(async () => {
      const selector = { handoffID: binding.handoffID, sessionID: binding.sessionID }
      const retained = await Source.retainedReceipt(selector)
      expect(retained?.kind).toBe(kind)
      expect(retained?.receipt.binding).toEqual(binding)
      expect(await Source.retainedReceipt({ ...selector, handoffID: "unknown" })).toBeUndefined()
      if (!retained) throw new Error("Missing original native receipt")
      const displaced = { ...selector, handoffID: "another-slot" }
      const key = ["session_transfer_source", displaced.handoffID, displaced.sessionID, kind]
      await Storage.write(key, retained.receipt)
      await expect(Source.retainedReceipt(displaced)).rejects.toThrow("selector")
      await Storage.remove(key)
      const opposite = [
        "session_transfer_source",
        selector.handoffID,
        selector.sessionID,
        kind === "surrendered" ? "cancelled" : "surrendered",
      ]
      await Storage.write(
        opposite,
        kind === "surrendered"
          ? {
              version: 1,
              binding,
              manifestHash: retained.receipt.manifestHash,
              members: retained.receipt.members,
            }
          : {
              version: 1,
              binding,
              manifestHash: "b".repeat(64),
              preparedHash: "a".repeat(64),
              members: retained.receipt.members,
            },
      )
      await expect(Source.retainedReceipt(selector)).rejects.toThrow("terminal")
      await Storage.remove(opposite)
      expect(await Source.retainedReceipt(selector)).toEqual(retained)
      if (kind === "surrendered") {
        const returned = {
          ...binding,
          handoffID: "returned-source",
          sourceID: binding.targetID,
          targetID: binding.sourceID,
          fromEpoch: binding.toEpoch,
          toEpoch: binding.toEpoch + 1,
        }
        const manifest = "c".repeat(64)
        await Epochs.reserve(returned, manifest, await Epochs.destinationPrior(returned))
        await Epochs.activate(returned, manifest, async () => {})
        expect((await Epochs.inspect(returned)).phase).toBe("activated")
        expect(await Source.retainedReceipt(selector)).toEqual(retained)
      }
    })
  },
)

import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferGate as Gate } from "../../src/session/transfer-gate"
import { Storage } from "../../src/storage/storage"

test("a final frozen parent cannot acquire a new native child after its aggregate inventory is sealed", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        await Epochs.freeze({
          sessionID: root.id,
          scopeID: "home",
          handoffID: "aggregate-membership-fence",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        })
        await expect(Session.create({ workspace: null, environmentID: null, parentID: root.id })).rejects.toThrow(
          "transfer",
        )
        expect((await Session.childPage({ parentID: root.id, includeArchived: true, limit: 1 })).items).toEqual([])
      },
    }),
  )
})

test("draining accepts native tail membership but legacy gates and reservations retain their existing authority", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "tail-membership",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const tail = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        expect(tail.parentID).toBe(root.id)
        await Epochs.cancel(binding)
        await Storage.write(Gate.key(root.id), {
          version: 1,
          migrationID: "legacy-parent",
          scopeID: "home",
          targetID: "B",
          phase: "prepared",
        })
        await expect(Session.create({ workspace: null, environmentID: null, parentID: root.id })).rejects.toThrow(
          "transfer",
        )
        await Storage.remove(Gate.key(root.id))
        await Storage.write(Gate.reservationKey(root.id), { migrationID: "legacy-target", scopeID: "home" })
        await expect(Session.create({ workspace: null, environmentID: null, parentID: root.id })).rejects.toThrow(
          "transfer",
        )
        expect(
          (await Session.childPage({ parentID: root.id, includeArchived: true })).items.map((entry) => entry.id),
        ).toEqual([tail.id])
      },
    }),
  )
})

test("a frozen parent's membership blocks moves and removal in the same native Session transaction", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        const other = await Session.create({ workspace: null, environmentID: null })
        const retained = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        const foreign = await Session.create({ workspace: null, environmentID: null, parentID: other.id })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        await Epochs.freeze({
          sessionID: root.id,
          scopeID: "home",
          handoffID: "membership-mutations",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        })
        await expect(
          Session.update(foreign.id, (draft) => {
            draft.parentID = root.id
          }),
        ).rejects.toThrow("transfer")
        expect((await Session.get(foreign.id)).parentID).toBe(other.id)
        await expect(Session.remove(retained.id)).rejects.toThrow("transfer")
        expect((await Session.get(retained.id)).parentID).toBe(root.id)
        expect(
          (await Session.childPage({ parentID: root.id, includeArchived: true })).items.map((entry) => entry.id),
        ).toEqual([retained.id])
      },
    }),
  )
})

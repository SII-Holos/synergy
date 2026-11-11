import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionInteraction } from "../../src/session/interaction"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"

test("aggregate activation publishes every reserved child in one paused transaction or publishes none", async () => {
  await using runtime = await testRuntime({ register() {
    StorageMutationGuard.register("fixture-leaf", async (_transaction, keys) => {
      for (const key of keys) if (key[0] === "fixture-leaf") await Epochs.assertOwnerMutation(key[1])
    })
  } })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = {
          sessionID: "ses_aggregate_root",
          scopeID: "home",
          handoffID: "aggregate",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const child = { ...root, sessionID: "ses_aggregate_child", rootSessionID: root.sessionID }
        const hash = "a".repeat(64)
        await Epochs.reserve(root, hash)
        await Epochs.reserve(child, hash)
        await expect(Storage.write(["fixture-leaf", child.sessionID], { value: "before" })).rejects.toThrow("frozen")
        const publish = async (valid: boolean) => {
          await Session.create({ id: root.sessionID, workspace: null })
          await SessionLifecycle.pause({ sessionID: root.sessionID, reason: "interrupted" })
          await Session.create({
            id: child.sessionID,
            parentID: valid ? root.sessionID : "missing-parent",
            workspace: null,
            interaction: SessionInteraction.unattended("machine-fixture"),
          })
          await Storage.write(["fixture-leaf", child.sessionID], { value: "activated" })
        }
        await expect(
          Epochs.activateMany({ bindings: [root, child], manifestHash: hash, publish: () => publish(false) }),
        ).rejects.toThrow()
        await expect(Session.get(root.sessionID)).rejects.toThrow()
        await expect(Session.get(child.sessionID)).rejects.toThrow()
        expect((await Epochs.inspect(root)).phase).toBe("prepared")
        expect((await Epochs.inspect(child)).phase).toBe("prepared")
        await Epochs.activateMany({ bindings: [root, child], manifestHash: hash, publish: () => publish(true) })
        expect((await Session.get(root.sessionID)).paused).toBeDefined()
        expect((await Session.get(child.sessionID)).paused).toBeUndefined()
        expect((await Epochs.inspect(root)).phase).toBe("activated")
        expect((await Epochs.inspect(child)).phase).toBe("activated")
        expect(await Storage.read(["fixture-leaf", child.sessionID])).toEqual({ value: "activated" })
        let replayed = false
        await Epochs.activateMany({
          bindings: [root, child],
          manifestHash: hash,
          publish: async () => {
            replayed = true
          },
        })
        expect(replayed).toBe(false)
      },
    }),
  )
})

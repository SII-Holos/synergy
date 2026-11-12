import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

test("source surrender permanently freezes the old epoch across restart and cannot be cancelled", async () => {
  await using directory = await tmpdir()
  let runtime = await testRuntime({ home: directory.path })
  try {
    const binding = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null })
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          const binding = {
            sessionID: session.id,
            scopeID: "home",
            handoffID: "first",
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.freeze(binding)
          await Epochs.seal(binding, "a".repeat(64))
          await Epochs.surrender(binding, "b".repeat(64))
          await expect(Epochs.cancel(binding)).rejects.toThrow("surrender")
          await expect(
            Session.update(session.id, (draft) => {
              draft.title = "forbidden"
            }),
          ).rejects.toThrow("transfer")
          expect(await Epochs.isFrozen(session.id)).toBe(true)
          expect((await Epochs.inspect(binding)).phase).toBe("surrendered")
          expect(await Storage.read(["session_transfer_epoch_current", session.id])).toMatchObject({
            epoch: 1,
            handoffID: "first",
          })
          return binding
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: directory.path })
    await runtime.run(async () => {
      expect(await Epochs.isFrozen(binding.sessionID)).toBe(true)
      expect((await Epochs.inspect(binding)).phase).toBe("surrendered")
      await expect(
        Session.update(binding.sessionID, (draft) => {
          draft.title = "after restart"
        }),
      ).rejects.toThrow("transfer")
    })
  } finally {
    await runtime.close()
  }
})

test("verified return activation advances the current epoch while retaining the old surrender ledger", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const outbound = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "outbound",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze(outbound)
        await Epochs.seal(outbound, "a".repeat(64))
        await Epochs.surrender(outbound, "b".repeat(64))
        const inbound = { ...outbound, handoffID: "return", sourceID: "B", targetID: "A", fromEpoch: 2, toEpoch: 3 }
        await expect(Epochs.reserve(inbound, "c".repeat(64))).rejects.toThrow("unrelated")
        const prior = await Epochs.destinationPrior(inbound)
        expect(prior).toEqual({
          handoffID: outbound.handoffID,
          fromEpoch: 1,
          manifestHash: "a".repeat(64),
        })
        await Epochs.reserve(inbound, "c".repeat(64), prior)
        let imported = 0
        await Epochs.activate(inbound, "c".repeat(64), async () => {
          imported++
          await Session.update(session.id, (draft) => {
            draft.title = "returned"
          })
        })
        await Epochs.activate(inbound, "c".repeat(64), async () => {
          imported++
        })
        expect(imported).toBe(1)
        expect(await Epochs.isFrozen(session.id)).toBe(false)
        expect((await Epochs.inspect(outbound)).phase).toBe("surrendered")
        expect((await Session.get(session.id)).title).toBe("returned")
        expect(await Storage.read(["session_transfer_epoch_current", session.id])).toMatchObject({ epoch: 3 })
      },
    }),
  )
})

test("destination retirement and activation are permanent alternatives", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const binding = {
      sessionID: "ses_new_target",
      scopeID: "home",
      handoffID: "retire",
      sourceID: "A",
      targetID: "B",
      fromEpoch: 1,
      toEpoch: 2,
    }
    const partial = { ...binding, sessionID: "ses_partial_target", handoffID: "partial-target" }
    await Storage.writeBinary(
      ["sessions", "home", partial.sessionID, "rollout", "blobs", "retained"],
      new Uint8Array([1, 2, 3]),
    )
    await expect(Epochs.reserve(partial, "b".repeat(64))).rejects.toThrow("unrelated")
    await Epochs.reserve(binding, "a".repeat(64))
    await Epochs.neverActivate(binding, "a".repeat(64))
    await expect(
      Epochs.activate(binding, "a".repeat(64), async () => {
        throw new Error("must not publish")
      }),
    ).rejects.toThrow("retired")
    expect((await Epochs.inspect(binding)).phase).toBe("never_activate")
    expect(await Epochs.isFrozen(binding.sessionID)).toBe(true)
    await expect(Epochs.reserve({ ...binding, handoffID: "reuse-retired-epoch" }, "b".repeat(64))).rejects.toThrow(
      "already been used",
    )
  })
})

test("upgrading legacy or incomplete epoch ledgers retains a non-executable fence", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const legacy = {
      version: 1,
      migrationID: "legacy-transfer",
      scopeID: "home",
      targetID: "old-host",
      phase: "committed",
    }
    await Storage.write(["session_transfer_gate", "ses_legacy"], legacy)
    const binding = {
      sessionID: "ses_orphan",
      scopeID: "home",
      handoffID: "old-epoch",
      sourceID: "A",
      targetID: "B",
      fromEpoch: 1,
      toEpoch: 2,
    }
    await Storage.write(["session_transfer_epochs", binding.sessionID, "1", binding.handoffID], {
      version: 1,
      binding,
      role: "source",
      phase: "surrendered",
      manifestHash: "a".repeat(64),
      preparedHash: "b".repeat(64),
    })
    await Epochs.upgrade()
    expect(await Storage.read(["session_transfer_epoch_legacy", "ses_legacy"])).toMatchObject({ gate: legacy })
    expect(await Epochs.isFrozen("ses_orphan")).toBe(true)
    expect(await Storage.read(["session_transfer_epoch_watermark", "ses_orphan"])).toMatchObject({ epoch: 2 })
    await expect(
      Epochs.reserve(
        { ...binding, handoffID: "uncertain-return", sourceID: "B", targetID: "A", fromEpoch: 2, toEpoch: 3 },
        "c".repeat(64),
      ),
    ).rejects.toThrow("unrelated")
  })
})

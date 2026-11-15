import { expect, test } from "bun:test"
import { z } from "zod"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageIntegrityError } from "../../src/storage/errors"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
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

test("epoch admission reads its independent markers in one fresh native statement", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Storage.transaction(async (tx) => {
      const raw = tx.raw
      const query = raw.query
      let statements = 0
      let observing = false
      raw.query = <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
        if (observing && statement.startsWith("SELECT ") && statement.includes("FROM storage_records")) statements++
        return query<Row>(statement, values, options)
      }
      try {
        const sessionID = "ses_epoch_marker_work"
        observing = true
        expect(await Epochs.isFrozen(sessionID)).toBe(false)
        observing = false
        const inspectStatements = statements
        statements = 0
        observing = true
        await Epochs.assertOwnerMutation(sessionID)
        observing = false
        const mutationStatements = statements
        expect(inspectStatements).toBe(1)
        expect(mutationStatements).toBe(1)
      } finally {
        raw.query = query
      }
    })
  })
})

test("epoch mutation admission sees each same-transaction fence and its rollback", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "fresh-admission",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        expect(await Epochs.isFrozen(session.id)).toBe(true)
        const current = ["session_transfer_epoch_current", session.id]
        const record = ["sessions", "home", session.id, "epoch-admission-test"]
        const rollback = new Error("rollback epoch fence")
        const outcome = await Storage.transaction(async () => {
          await Storage.write(record, { admitted: "draining" })
          await Storage.write(current, { version: 1, scopeID: "home", epoch: 1, uncertain: true })
          const rejected = await Storage.write(record, { admitted: "forbidden" }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(rejected).toBeInstanceOf(Epochs.Rejected)
          expect(await Storage.read(record)).toEqual({ admitted: "draining" })
          await Storage.remove(current)
          await Storage.write(record, { admitted: "fence removed" })
          await Storage.write(current, { version: 1, scopeID: "home", epoch: 1, uncertain: true })
          throw rollback
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(outcome).toBe(rollback)
        expect(await Storage.readMany([current, record])).toEqual([undefined, undefined])
        await Storage.write(record, { admitted: "after rollback" })
        expect(await Storage.read(record)).toEqual({ admitted: "after rollback" })
        expect(await Epochs.isFrozen(session.id)).toBe(true)
      },
    }),
  )
})

test("epoch marker snapshots retain schema short circuits and fail closed on corrupt encoding", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const sessionID = "ses_epoch_marker_errors"
    const binding = {
      sessionID,
      scopeID: "home",
      handoffID: "marker-errors",
      sourceID: "A",
      targetID: "B",
      fromEpoch: 1,
      toEpoch: 2,
    }
    const reservation = ["session_transfer_epoch_reservation", sessionID]
    const current = ["session_transfer_epoch_current", sessionID]
    const intent = ["session_transfer_epoch_source_intent", sessionID]
    const index = ["session_index", sessionID]
    const state = ["session_transfer_epochs", sessionID, "1", binding.handoffID]
    const body = ["sessions", "home", sessionID, "epoch-admission-test"]
    const reserved = { version: 1, binding, role: "target", phase: "prepared" }
    const pointer = { version: 1, scopeID: "home", epoch: 1 }
    const rollback = new Error("rollback damaged epoch markers")
    const outcome = await Storage.transaction(async (tx) => {
      await Storage.write(reservation, reserved)
      await Storage.write(current, pointer)
      await tx.raw.query("UPDATE storage_records SET body = ? WHERE namespace = ? AND key_text = ?", [
        "{",
        tx.namespace,
        JSON.stringify(current),
      ])
      const encoded = await Epochs.isFrozen(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(encoded).toBeInstanceOf(StorageIntegrityError)
      const mutation = await Storage.write(body, { admitted: "forbidden" }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(mutation).toBeInstanceOf(StorageIntegrityError)
      expect(await Storage.readMany([body])).toEqual([undefined])
      await Storage.write(current, { ...pointer, epoch: "invalid" })
      await Storage.write(intent, { version: 2 })
      expect(await Epochs.isFrozen(sessionID)).toBe(true)
      await Storage.write(reservation, { ...reserved, phase: "activated" })
      await Storage.write(current, { ...pointer, uncertain: true })
      expect(await Epochs.isFrozen(sessionID)).toBe(true)
      await Storage.write(reservation, { ...reserved, phase: "invalid" })
      const first = await Epochs.isFrozen(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(first).toBeInstanceOf(z.ZodError)
      if (!(first instanceof z.ZodError)) throw first
      expect(first.issues[0]?.path).toEqual(["phase"])
      await Storage.remove(reservation)
      await Storage.write(current, pointer)
      await Storage.write(index, { scopeID: 1 })
      const schema = await Epochs.isFrozen(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(schema).toBeInstanceOf(z.ZodError)
      if (!(schema instanceof z.ZodError)) throw schema
      expect(schema.issues[0]?.path).toEqual(["version"])
      await Storage.write(intent, { version: 1, binding })
      await Storage.write(state, { version: 1, binding, role: "source", phase: "draining" })
      expect(await Epochs.isFrozen(sessionID)).toBe(true)
      await Storage.write(state, { version: 1, binding, role: "source", phase: "invalid" })
      const dependent = await Epochs.isFrozen(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(dependent).toBeInstanceOf(z.ZodError)
      if (!(dependent instanceof z.ZodError)) throw dependent
      expect(dependent.issues[0]?.path).toEqual(["phase"])
      await Storage.remove(intent)
      const indexed = await Epochs.isFrozen(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(indexed).toBeInstanceOf(z.ZodError)
      if (!(indexed instanceof z.ZodError)) throw indexed
      expect(indexed.issues[0]?.path).toEqual(["scopeID"])
      throw rollback
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(outcome).toBe(rollback)
    expect(await Storage.readMany([reservation, current, intent, index, state, body])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(await Epochs.isFrozen(sessionID)).toBe(false)
  })
})

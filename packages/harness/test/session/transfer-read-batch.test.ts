import { expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

for (const backend of storageTestBackends()) {
  test(`listing transfer enrichment observes current durable records without retaining projections (${backend})`, async () => {
    await using runtime = await testRuntime({
      postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined,
    })
    await runtime.run(async () => {
      await using files = await tmpdir()
      const scope = await files.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const parent = await Session.create({ workspace: null })
          const child = await Session.create({ parentID: parent.id, workspace: null })
          const sibling = await Session.create({ parentID: parent.id, workspace: null })
          const transfer: NonNullable<Session.Info["transfer"]> = {
            migrationID: crypto.randomUUID(),
            sessionID: child.id,
            sourceID: crypto.randomUUID(),
            targetID: crypto.randomUUID(),
            phase: "prepared",
          }
          const key = ["session_transfer_out", child.id]
          await Storage.write(key, transfer)
          expect((await Session.get(child.id)).transfer).toEqual(transfer)
          const children = await Session.children(parent.id)
          expect(children.find((session) => session.id === child.id)?.transfer).toEqual(transfer)
          expect(children.find((session) => session.id === sibling.id)?.transfer).toBeUndefined()
          expect(
            (await Session.list({ parentOnly: false })).data.find((session) => session.id === child.id)?.transfer,
          ).toEqual(transfer)
          expect(
            (await Session.list({ parentOnly: false, search: child.title })).data.find(
              (session) => session.id === child.id,
            )?.transfer,
          ).toEqual(transfer)
          await Storage.write(key, { ...transfer, phase: "completed" })
          expect((await Session.get(child.id)).transfer?.phase).toBe("completed")
          expect(
            (await Session.childPage({ parentID: parent.id })).items.find((session) => session.id === child.id)
              ?.transfer?.phase,
          ).toBe("completed")
          await Storage.write(key, { ...transfer, phase: "cancelled" })
          expect((await Session.get(child.id)).transfer).toBeUndefined()
          expect(
            (await Session.children(parent.id)).find((session) => session.id === child.id)?.transfer,
          ).toBeUndefined()
          await Storage.write(key, { invalid: true })
          await expect(Session.children(parent.id)).rejects.toThrow()
        },
      })
    })
  })

  test(`transfer mutation admission reads both durable fences in one batch without caching (${backend})`, async () => {
    await using runtime = await testRuntime({
      postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined,
    })
    await runtime.run(async () => {
      const readMany = StoreTransaction.prototype.readMany
      let fenceReads = 0
      using _readMany = spyOn(StoreTransaction.prototype, "readMany").mockImplementation(function <T>(
        this: StoreTransaction,
        keys: string[][],
      ) {
        if (keys.some((key) => ["session_transfer_gate", "session_transfer_reservation"].includes(key[0]))) fenceReads++
        return readMany.call(this, keys) as Promise<(T | undefined)[]>
      })
      const sessionID = Identifier.ascending("session")
      const mutation = ["sessions", "home", sessionID, "test"]
      await Storage.transaction(async () => {
        await Storage.write(mutation, { before: true })
      })
      expect(fenceReads).toBe(1)
      const gate = {
        version: 1,
        migrationID: crypto.randomUUID(),
        scopeID: "home",
        targetID: crypto.randomUUID(),
        phase: "prepared",
      }
      fenceReads = 0
      await expect(
        Storage.transaction(async () => {
          await Storage.write(mutation, { abandoned: true })
          await Storage.write(["session_transfer_gate", sessionID], gate)
          await Storage.write(mutation, { forbidden: true })
        }),
      ).rejects.toThrow("transfer")
      expect(fenceReads).toBe(2)
      expect(await Storage.read<Record<string, boolean>>(mutation)).toEqual({ before: true })
      await expect(Storage.read(["session_transfer_gate", sessionID])).rejects.toBeInstanceOf(Storage.NotFoundError)
      await Storage.write(["session_transfer_reservation", sessionID], {
        migrationID: gate.migrationID,
        scopeID: "home",
      })
      await expect(Storage.write(mutation, { forbidden: true })).rejects.toThrow("reserves")
      expect(await Storage.read<Record<string, boolean>>(mutation)).toEqual({ before: true })
      await Storage.write(["session_transfer_gate", sessionID], gate)
      const unrelatedMutation = ["sessions", "home", Identifier.ascending("session"), "test"]
      const mutateOwners = () =>
        Storage.transaction((tx) =>
          tx.writeMany([
            { key: unrelatedMutation, value: { abandoned: true } },
            { key: mutation, value: { forbidden: true } },
          ]),
        )
      fenceReads = 0
      await expect(mutateOwners()).rejects.toMatchObject({
        data: { sessionID, message: expect.stringContaining("reserves") },
      })
      expect(fenceReads).toBe(1)
      await Storage.remove(["session_transfer_reservation", sessionID])
      await expect(mutateOwners()).rejects.toMatchObject({ data: { sessionID, migrationID: gate.migrationID } })
      expect(fenceReads).toBe(2)
      await expect(Storage.read(unrelatedMutation)).rejects.toBeInstanceOf(Storage.NotFoundError)
    })
  })
}

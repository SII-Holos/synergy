import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeTypes } from "../../src/lattice/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("LatticeStore v2", () => {
  test("preserves terminal run history and advances the session current pointer", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      await expect(LatticeStore.create({ sessionID, mode: "auto" })).rejects.toThrow()

      await LatticeStore.updateByRunID(scopeID, first.id, (draft) => {
        draft.status = "completed"
        draft.time.completed = Date.now()
      })
      const second = await LatticeStore.create({ sessionID, mode: "collaborative" })

      expect(second.id).not.toBe(first.id)
      expect((await LatticeStore.get(scopeID, sessionID)).id).toBe(second.id)
      expect((await LatticeStore.getByRunID(scopeID, first.id))?.status).toBe("completed")
      expect((await LatticeStore.list(scopeID)).map((run) => run.id)).toEqual([first.id, second.id])
    })
  })

  test("serializes concurrent session updates without a lock-external rewrite", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const run = await LatticeStore.create({ sessionID, mode: "auto" })

      await Promise.all(
        Array.from({ length: 32 }, () =>
          LatticeStore.update(scopeID, sessionID, (draft) => {
            draft.modelCallCount++
          }),
        ),
      )

      const stored = await LatticeStore.getByRunID(scopeID, run.id)
      expect(stored?.modelCallCount).toBe(32)
      expect(stored?.revision).toBe(32)
    })
  })

  test("increments persisted revisions exactly once for pause and resume", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const initial = await LatticeStore.create({ sessionID, mode: "auto" })
      const paused = await LatticeStore.updateByRunID(scopeID, initial.id, (draft) =>
        LatticeMachine.pause(draft, "user_paused"),
      )
      const resumed = await LatticeStore.updateByRunID(scopeID, initial.id, (draft) => LatticeMachine.resume(draft))

      expect(paused.revision).toBe(1)
      expect(paused.stateRevision).toBe(1)
      expect(resumed.revision).toBe(2)
      expect(resumed.stateRevision).toBe(2)
    })
  })

  test("quarantines every effect before selecting among duplicate active Runs", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      const firstWithEffect = await LatticeStore.updateByRunID(scopeID, first.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry", deliveryKey: `lattice:${first.id}` }),
      )
      const second = {
        ...firstWithEffect,
        id: Identifier.ascending("lattice_run"),
        revision: 0,
        time: {
          ...firstWithEffect.time,
          created: firstWithEffect.time.created + 1,
          updated: firstWithEffect.time.updated + 1,
        },
      }
      await Storage.write(StoragePath.latticeRun(sid, second.id), second)
      await Storage.remove(StoragePath.latticeCurrent(sid, sessionID))

      const selected = await LatticeStore.repairCurrentPointer(scopeID, sessionID)
      const older = await LatticeStore.getByRunID(scopeID, first.id)
      const newer = await LatticeStore.getByRunID(scopeID, second.id)

      expect(selected?.id).toBe(second.id)
      expect(older).toMatchObject({ status: "failed", statusReason: "duplicate_active_run" })
      expect(newer).toMatchObject({ status: "paused", statusReason: "duplicate_active_run" })
      expect(older?.effect).toBeUndefined()
      expect(newer?.effect).toBeUndefined()
    })
  })

  test("quarantines the selected duplicate before an interrupted cleanup can expose its effect", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      const firstWithEffect = await LatticeStore.updateByRunID(scopeID, first.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry", deliveryKey: `lattice:${first.id}` }),
      )
      const second = LatticeTypes.Run.parse({
        ...firstWithEffect,
        id: Identifier.ascending("lattice_run"),
        revision: 0,
        effect: {
          ...firstWithEffect.effect!,
          id: Identifier.ascending("lattice_effect"),
          deliveryKey: `lattice:second:prompt`,
        },
        time: {
          ...firstWithEffect.time,
          created: firstWithEffect.time.created + 1,
          updated: firstWithEffect.time.updated + 1,
        },
      })
      await Storage.write(StoragePath.latticeRun(sid, second.id), second)

      const quarantine = LatticeMachine.quarantineDuplicate
      let calls = 0
      ;(LatticeMachine.quarantineDuplicate as typeof quarantine) = (...args) => {
        calls++
        if (calls === 2) throw new Error("simulated crash")
        return quarantine(...args)
      }
      try {
        await expect(LatticeStore.listCurrent(scopeID)).rejects.toThrow("simulated crash")
      } finally {
        ;(LatticeMachine.quarantineDuplicate as typeof quarantine) = quarantine
      }

      expect(await LatticeStore.getByRunID(scopeID, second.id)).toMatchObject({
        status: "paused",
        statusReason: "duplicate_active_run",
      })
      expect((await LatticeStore.getByRunID(scopeID, second.id))?.effect).toBeUndefined()
      expect((await LatticeStore.getByRunID(scopeID, first.id))?.status).toBe("active")

      await LatticeStore.listCurrent(scopeID)
      expect(await LatticeStore.getByRunID(scopeID, first.id)).toMatchObject({
        status: "failed",
        statusReason: "duplicate_active_run",
      })
      expect((await LatticeStore.getByRunID(scopeID, first.id))?.effect).toBeUndefined()
    })
  })

  test("repairs a missing session pointer from runID-keyed records", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const run = await LatticeStore.create({ sessionID, mode: "auto" })
      await Storage.remove(StoragePath.latticeCurrent(Identifier.asScopeID(scopeID), sessionID))

      const repaired = await LatticeStore.repairCurrentPointer(scopeID, sessionID)
      expect(repaired?.id).toBe(run.id)
      expect((await LatticeStore.get(scopeID, sessionID)).id).toBe(run.id)
    })
  })

  test("repairs a stale terminal pointer when a newer active Run exists", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      await LatticeStore.updateByRunID(scopeID, first.id, (draft) => {
        draft.status = "completed"
        draft.time.completed = Date.now()
      })
      const second = await LatticeStore.create({ sessionID, mode: "auto" })
      const pointerKey = StoragePath.latticeCurrent(sid, sessionID)
      const pointer = await Storage.read<LatticeTypes.CurrentPointer>(pointerKey)
      await Storage.write(pointerKey, { ...pointer, runID: first.id })

      expect((await LatticeStore.get(scopeID, sessionID)).id).toBe(second.id)
      expect((await Storage.read<LatticeTypes.CurrentPointer>(pointerKey)).runID).toBe(second.id)
    })
  })

  test("cold-start listing repairs an orphan active Run with no pointer", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const run = await LatticeStore.create({ sessionID, mode: "auto" })
      await Storage.remove(StoragePath.latticeCurrent(sid, sessionID))

      expect((await LatticeStore.listCurrent(scopeID)).map((candidate) => candidate.id)).toEqual([run.id])
      expect((await Storage.read<LatticeTypes.CurrentPointer>(StoragePath.latticeCurrent(sid, sessionID))).runID).toBe(
        run.id,
      )
    })
  })

  test("cold-start listing quarantines duplicate active Runs even when the pointer is valid", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      const firstWithEffect = await LatticeStore.updateByRunID(scopeID, first.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry", deliveryKey: `lattice:${first.id}` }),
      )
      const second = LatticeTypes.Run.parse({
        ...firstWithEffect,
        id: Identifier.ascending("lattice_run"),
        revision: 0,
        time: {
          ...firstWithEffect.time,
          created: firstWithEffect.time.created + 1,
          updated: firstWithEffect.time.updated + 1,
        },
      })
      await Storage.write(StoragePath.latticeRun(sid, second.id), second)

      const current = await LatticeStore.listCurrent(scopeID)
      const older = await LatticeStore.getByRunID(scopeID, first.id)
      const newer = await LatticeStore.getByRunID(scopeID, second.id)

      expect(current.map((run) => run.id)).toEqual([second.id])
      expect(older).toMatchObject({ status: "failed", statusReason: "duplicate_active_run" })
      expect(newer).toMatchObject({ status: "paused", statusReason: "duplicate_active_run" })
      expect(older?.effect).toBeUndefined()
      expect(newer?.effect).toBeUndefined()
    })
  })

  test("does not rewrite an already correct current pointer during cold-start listing", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sid = Identifier.asScopeID(scopeID)
      const sessionID = Identifier.ascending("session")
      const run = await LatticeStore.create({ sessionID, mode: "auto" })
      const pointerKey = StoragePath.latticeCurrent(sid, sessionID)
      const pointer = await Storage.read<LatticeTypes.CurrentPointer>(pointerKey)
      await Storage.write(pointerKey, { ...pointer, time: { created: 10, updated: 20 } })

      expect((await LatticeStore.listCurrent(scopeID)).map((candidate) => candidate.id)).toEqual([run.id])
      expect((await Storage.read<LatticeTypes.CurrentPointer>(pointerKey)).time).toEqual({ created: 10, updated: 20 })
    })
  })

  test("stores events under the immutable run identity", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const first = await LatticeStore.create({ sessionID, mode: "auto" })
      await LatticeStore.appendEvent(scopeID, first, { kind: "run_paused", message: "test" })
      await LatticeStore.updateByRunID(scopeID, first.id, (draft) => {
        draft.status = "completed"
        draft.time.completed = Date.now()
      })
      const second = await LatticeStore.create({ sessionID, mode: "auto" })

      expect((await LatticeStore.listEvents(scopeID, first.id)).map((event) => event.runID)).toEqual([
        first.id,
        first.id,
      ])
      expect((await LatticeStore.listEvents(scopeID, second.id)).map((event) => event.runID)).toEqual([second.id])
    })
  })

  test("deduplicates retried best-effort audit events", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const sessionID = Identifier.ascending("session")
      const run = await LatticeStore.create({ sessionID, mode: "auto" })

      const first = await LatticeStore.appendEvent(scopeID, run, {
        kind: "run_paused",
        state: run.state,
        message: "user_paused",
      })
      const retried = await LatticeStore.appendEvent(scopeID, run, {
        kind: "run_paused",
        state: run.state,
        message: "user_paused",
      })

      expect(retried.id).toBe(first.id)
      expect(
        (await LatticeStore.listEvents(scopeID, run.id)).filter((event) => event.kind === "run_paused"),
      ).toHaveLength(1)
    })
  })
})

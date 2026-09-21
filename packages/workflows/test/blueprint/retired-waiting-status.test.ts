import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { migrations } from "../../src/blueprint/migration"
import { BlueprintLoopStore, isActiveLoopStatus } from "../../src/blueprint/loop-store"
import { LoopError } from "../../src/blueprint/error"
import type { Info as BlueprintLoopInfo } from "../../src/blueprint/types"

const MIGRATION_ID = "20260920-blueprint-loop-retired-waiting-status"

function migration() {
  const entry = migrations.find((item) => item.id === MIGRATION_ID)
  expect(entry).toBeDefined()
  return entry!
}

/**
 * The exact pre-change record: `waiting` was this domain's own pause authority,
 * written by the retired `wait` route.
 *
 * Typed as the persisted shape rather than as today's `Info`, because `waiting`
 * is deliberately absent from `LoopStatus` — a legacy record cannot be expressed
 * as a current one, which is the problem the upgrade exists to solve.
 */
function waitingLoop(scopeID: string, sessionID: string, loopID = Identifier.ascending("blueprint_loop")) {
  const now = Date.now()
  return {
    id: loopID,
    noteID: "note_waiting",
    title: "Held Blueprint",
    sessionID,
    auditAgent: "supervisor",
    scopeID: scopeID as string,
    status: "waiting" as string,
    source: "user" as string,
    time: { created: now - 1_000, updated: now },
  }
}

describe("retired waiting BlueprintLoop upgrade", () => {
  test("converts a persisted waiting loop so it is transitionable again", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)
      const session = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "Held" }) })
      const loop = waitingLoop(scopeID, session.id)
      await Storage.write(StoragePath.blueprintLoop(scopeID, loop.id), loop)

      await ScopeContext.provide({
        scope,
        fn: async () => {
          // The defect: `waiting` has no row in the transition table any more, so
          // every later transition — including the cancellation `abandonLoop`
          // performs — throws instead of recording anything.
          await expect(
            BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" }),
          ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
          // …and the active-status gate that `abandonWorkflow` consults does not
          // match it either, so no domain path would clear the record. The value is
          // asserted through the current enum on purpose: the mismatch between what
          // is persisted and what the gate accepts is the defect.
          expect(isActiveLoopStatus(loop.status as BlueprintLoopInfo["status"])).toBe(false)

          await migration().up(() => {})

          const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loop.id))
          expect(migrated.status).toBe("running")
          // Mirrors the store's own entry into `running`, so the record is a valid
          // running loop rather than a waiting one relabelled.
          expect((migrated.time as Record<string, unknown>).started).toBeNumber()
          expect(isActiveLoopStatus(migrated.status as BlueprintLoopInfo["status"])).toBe(true)

          // Abandonment is the real user path: `abandonWorkflow` reaches this exact
          // call, and it only runs at all because the gate above now matches.
          const cancelled = await BlueprintLoopStore.updateStatus(scope.id, loop.id, {
            status: "cancelled",
            error: "Stopped by user request",
          })
          expect(cancelled.status).toBe("cancelled")
          expect(cancelled.time.completed).toBeNumber()

          await Session.remove(session.id)
        },
      })
    }))

  test("moves the retired hold onto the bound session as a workflow pause", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)
      const session = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "Held" }) })
      const loop = waitingLoop(scopeID, session.id)
      await Storage.write(StoragePath.blueprintLoop(scopeID, loop.id), loop)

      await migration().up(() => {})

      const stored = await Storage.read<Record<string, unknown>>(
        StoragePath.sessionInfo(scopeID, Identifier.asSessionID(session.id)),
      )
      // The stop the user asked for survives as the session's own latch, which is
      // the surviving authority for it; the reason names the workflow that held it.
      expect(stored.paused).toMatchObject({ reason: "workflow" })
      expect(String((stored.paused as Record<string, unknown>).description)).toContain("BlueprintLoop")
      // The session's binding is untouched, so continue and abandon still resolve
      // the same loop.
      expect(stored.blueprint).toBeUndefined()

      await ScopeContext.provide({ scope, fn: () => Session.remove(session.id) })
    }))

  test("is re-entrant and does not churn an already-upgraded store", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)
      const session = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "Held" }) })
      const loop = waitingLoop(scopeID, session.id)
      await Storage.write(StoragePath.blueprintLoop(scopeID, loop.id), loop)
      const sessionKey = StoragePath.sessionInfo(scopeID, Identifier.asSessionID(session.id))

      await migration().up(() => {})
      const loopAfterFirst = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loop.id))
      const sessionAfterFirst = await Storage.read<Record<string, unknown>>(sessionKey)

      await migration().up(() => {})
      const loopAfterSecond = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loop.id))
      const sessionAfterSecond = await Storage.read<Record<string, unknown>>(sessionKey)

      // Byte-identical, including `started` and `since`: a converted record is no
      // longer `waiting`, so a second pass has nothing to convert, and the
      // first-pause-wins rule keeps the original timestamp the user sees.
      expect(loopAfterSecond).toEqual(loopAfterFirst)
      expect(sessionAfterSecond).toEqual(sessionAfterFirst)

      await ScopeContext.provide({ scope, fn: () => Session.remove(session.id) })
    }))

  test("fresh install, terminal loops, and latch-exempt sessions are untouched", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)

      const live = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "Live" }) })
      const archived = await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Session.create({ title: "Archived" })
          await Session.update(created.id, (draft) => {
            draft.time.archived = Date.now()
          })
          return created
        },
      })
      const machine = await ScopeContext.provide({
        scope,
        fn: () => Session.create({ title: "Machine", interaction: SessionInteraction.unattended("agenda") }),
      })

      // A current-shape loop, a terminal loop, and two waiting loops whose sessions
      // the latch deliberately excludes.
      const running = waitingLoop(scopeID, live.id)
      running.status = "running"
      const completed = waitingLoop(scopeID, live.id)
      completed.status = "completed"
      const archivedLoop = waitingLoop(scopeID, archived.id)
      const machineLoop = waitingLoop(scopeID, machine.id)
      for (const loop of [running, completed, archivedLoop, machineLoop])
        await Storage.write(StoragePath.blueprintLoop(scopeID, loop.id), loop)
      const before = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, running.id))

      await migration().up(() => {})

      // Only the waiting loops convert; a current-shape loop and a terminal one are
      // not this migration's business.
      expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, running.id))).toEqual(
        before,
      )
      expect(
        (await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, completed.id))).status,
      ).toBe("completed")
      expect(
        (await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, archivedLoop.id))).status,
      ).toBe("running")
      expect(
        (await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, machineLoop.id))).status,
      ).toBe("running")

      const liveStored = await Storage.read<Record<string, unknown>>(
        StoragePath.sessionInfo(scopeID, Identifier.asSessionID(live.id)),
      )
      const archivedStored = await Storage.read<Record<string, unknown>>(
        StoragePath.sessionInfo(scopeID, Identifier.asSessionID(archived.id)),
      )
      const machineStored = await Storage.read<Record<string, unknown>>(
        StoragePath.sessionInfo(scopeID, Identifier.asSessionID(machine.id)),
      )
      // An archived session's latch would be unreachable state, and a machine
      // session is driven by a domain that reconciles its own work — latching
      // either would leave a stop nobody can clear. The same two exclusions
      // `SessionLifecycle.latchable` applies.
      expect(liveStored.paused).toBeUndefined()
      expect(archivedStored.paused).toBeUndefined()
      expect(machineStored.paused).toBeUndefined()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          for (const session of [live, archived, machine]) await Session.remove(session.id)
        },
      })
    }))

  test("a loop whose session is missing does not fail the migration", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)
      const loop = waitingLoop(scopeID, Identifier.ascending("session"))
      await Storage.write(StoragePath.blueprintLoop(scopeID, loop.id), loop)

      await migration().up(() => {})

      const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loop.id))
      expect(migrated.status).toBe("running")
    }))
})

afterRuntimeTests(() => runtime.close())

import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { waitingPhaseMigration } from "../../src/session-migration"
import { bindingSourceAccessMigration } from "../../src/binding-source-migration"

const runtime = await testRuntime()
const receipt = (scopeID: string, sessionID: string) => [
  "sessions",
  scopeID,
  sessionID,
  "migrations",
  "blueprint-session",
  waitingPhaseMigration.id,
]

async function seedWaitingPhaseSession(paused?: Record<string, unknown>) {
  const scopeID = ScopeContext.current.scope.id
  const session = await Session.create({ title: "Held Blueprint session" })
  const key = StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(session.id))
  const loopID = Identifier.ascending("blueprint_loop")
  await Storage.write(["blueprint_loops", scopeID, loopID], {
    id: loopID,
    scopeID,
    sessionID: session.id,
    source: "user",
    status: "running",
    time: { created: 1, updated: 1 },
  })
  const stored = await Storage.read<Record<string, unknown>>(key)
  const original = {
    ...stored,
    blueprint: { loopID, loopRole: "execution", phase: "waiting", future: { keep: true } },
    ...(paused ? { paused } : {}),
    futureOwner: { retained: true },
  }
  await Storage.write(key, original)
  await Storage.remove(receipt(scopeID, session.id))
  await Storage.remove([
    "sessions",
    scopeID,
    session.id,
    "migrations",
    "blueprint-session",
    bindingSourceAccessMigration.id,
  ])
  return { sessionID: session.id, key, original, loopID }
}

describe("Blueprint-owned retired waiting phase", () => {
  test("upgrades before public validation and navigation without changing the bound loop", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { sessionID, key, loopID } = await seedWaitingPhaseSession()
          expect(Session.Info.safeParse(await Storage.read<Record<string, unknown>>(key)).success).toBe(false)
          const index = await SessionNav.buildNavIndex(ScopeContext.current.scope.id)
          expect(index.entries.find((entry) => entry.id === sessionID)?.blueprint).toEqual({
            loopID,
            loopRole: "execution",
            phase: "running",
          })
          const session = await Session.get(sessionID)
          expect(Session.Info.safeParse(session).success).toBe(true)
          expect(await SessionLifecycle.blocksDrive(session)).toBe(true)
          expect(await Storage.read<Record<string, unknown>>(key)).toMatchObject({
            blueprint: { loopID, loopRole: "execution", phase: "running", source: "user", future: { keep: true } },
            paused: { reason: "workflow" },
            futureOwner: { retained: true },
          })
        },
      })
    }))

  test("the owner conversion and receipt roll back together, then retry once without touching another session", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { sessionID, key, original } = await seedWaitingPhaseSession()
          const other = await seedWaitingPhaseSession()
          const ownerReceipt = receipt(ScopeContext.current.scope.id, sessionID)
          const writeMany = StoreTransaction.prototype.writeMany
          let interrupted = false
          const failure = spyOn(StoreTransaction.prototype, "writeMany").mockImplementation(async function (
            this: StoreTransaction,
            entries,
          ) {
            await writeMany.call(this, entries)
            if (entries.some(({ key }) => key.join("/") === ownerReceipt.join("/"))) {
              interrupted = true
              throw new Error("owner receipt interrupted")
            }
          })
          try {
            await expect(Session.get(sessionID)).rejects.toThrow("owner receipt interrupted")
          } finally {
            failure.mockRestore()
          }
          expect(interrupted).toBe(true)
          expect(await Storage.read<Record<string, unknown>>(key)).toEqual(original)
          expect((await Storage.readMany([ownerReceipt]))[0]).toBeUndefined()
          expect(await Storage.read<Record<string, unknown>>(other.key)).toEqual(other.original)

          await Session.get(sessionID)
          const upgraded = await Storage.read<Record<string, unknown>>(key)
          expect(upgraded).toMatchObject({ blueprint: { phase: "running" }, paused: { reason: "workflow" } })
          expect(await Storage.read(ownerReceipt)).toHaveProperty("completed")
          await Session.get(sessionID)
          expect(await Storage.read<Record<string, unknown>>(key)).toEqual(upgraded)
          expect(await Storage.read<Record<string, unknown>>(other.key)).toEqual(other.original)
        },
      })
    }))

  test("retains the first pause and leaves fresh sessions unchanged", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const paused = { reason: "interrupted", description: "Reply owed", since: 1234 }
          const held = await seedWaitingPhaseSession(paused)
          await Session.get(held.sessionID)
          expect(await Storage.read<Record<string, unknown>>(held.key)).toMatchObject({
            blueprint: { phase: "running" },
            paused,
          })

          const fresh = await Session.create({ title: "Fresh session" })
          const key = ["sessions", ScopeContext.current.scope.id, fresh.id, "info"]
          const before = await Storage.read<Record<string, unknown>>(key)
          await Session.get(fresh.id)
          expect(await Storage.read<Record<string, unknown>>(key)).toEqual(before)
        },
      })
    }))

  test("explicit nav repair discovers an old dropped session despite completed shared receipts", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { sessionID } = await seedWaitingPhaseSession()
          const scopeID = ScopeContext.current.scope.id
          const navKey = StoragePath.sessionNavIndex(Identifier.asScopeID(scopeID))
          await Storage.write(navKey, { ...(await Storage.read<Record<string, unknown>>(navKey)), entries: [] })
          const ledgerKey = StoragePath.metaMigrationLogDomain("session")
          await Storage.write(ledgerKey, {
            ...(await Storage.read<Record<string, number>>(ledgerKey)),
            "20260920-session-blueprint-waiting-phase": 42,
            "20260920-session-nav-blueprint-waiting-phase": 42,
          })
          expect((await SessionNav.readNavIndex(scopeID)).entries).toEqual([])
          const repaired = await SessionNav.buildNavIndex(scopeID)
          expect(repaired.entries.find((entry) => entry.id === sessionID)?.blueprint?.phase).toBe("running")
          expect(await Storage.read(receipt(scopeID, sessionID))).toHaveProperty("completed")
        },
      })
    }))
})

afterAll(() => runtime.close())

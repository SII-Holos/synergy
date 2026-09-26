import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { getMigrationStatus, runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { migrations } from "@ericsanchezok/synergy-harness/test/internal/session/migration"

const PHASE_ID = "20260920-session-blueprint-waiting-phase"
const NAV_ID = "20260920-session-nav-blueprint-waiting-phase"

/**
 * The upgrade path for a store written before the workflow's own pause authority
 * was retired.
 *
 * `blueprint.phase: "waiting"` is part of the composed `Session.Info`, so a store
 * that still holds it cannot parse its own session record. The navigation
 * projection skips a record it cannot parse, which means the user loses the
 * session from the sidebar rather than seeing it upgraded. These tests seed the
 * exact pre-change shape and prove the declared conversion brings the store
 * forward.
 */
async function seedWaitingPhaseSession(scope: Scope, loopID = "bll_legacy") {
  const session = await Session.create({ title: "Held Blueprint session" })
  const key = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id))
  const stored = await Storage.read<Record<string, unknown>>(key)
  await Storage.write(key, { ...stored, blueprint: { loopID, loopRole: "execution", phase: "waiting" } })
  return { sessionID: session.id, key }
}

/** Mark every migration in every domain complete except the ones under test, so
 *  the real runner executes exactly this change. Mirrors how the storage suites
 *  pin a single pending migration. */
async function ledgerExcluding(ids: string[]) {
  const touched = new Set<string>()
  const previous = new Map<string, Record<string, number> | undefined>()
  for (const [owner, list] of MigrationRegistry.list()) {
    for (const migration of list) {
      const domain = migration.domain ?? owner
      if (touched.has(domain)) continue
      touched.add(domain)
      const key = StoragePath.metaMigrationLogDomain(domain)
      previous.set(domain, await Storage.read<Record<string, number>>(key).catch(() => undefined))
    }
  }
  for (const domain of touched) {
    const entries: Record<string, number> = {}
    for (const [owner, list] of MigrationRegistry.list()) {
      for (const migration of list) {
        if ((migration.domain ?? owner) !== domain) continue
        if (ids.includes(migration.id)) continue
        entries[migration.id] = 1
      }
    }
    await Storage.write(StoragePath.metaMigrationLogDomain(domain), entries)
  }
  return async () => {
    for (const domain of touched) {
      const key = StoragePath.metaMigrationLogDomain(domain)
      const before = previous.get(domain)
      if (before) await Storage.write(key, before)
      else await Storage.remove(key).catch(() => undefined)
    }
  }
}

describe("retired waiting Blueprint phase upgrade", () => {
  test("an upgrading store keeps the session and reports it in the navigation index", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const scopeID = Identifier.asScopeID(scope.id)

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const { sessionID, key } = await seedWaitingPhaseSession(scope)

          // The defect, reproduced on the exact stored shape: the record does not
          // parse, and the navigation projection therefore hides the session.
          const before = Session.Info.safeParse(await Storage.read<unknown>(key))
          expect(before.success).toBe(false)
          if (!before.success)
            expect(before.error.issues.map((issue) => issue.path.join("."))).toContain("blueprint.phase")

          await SessionNav.rebuildAllNavIndexes()
          expect((await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)).toBeUndefined()

          // The declared order, executed by the real runner.
          const restore = await ledgerExcluding([PHASE_ID, NAV_ID])
          try {
            const summary = await runMigrations({ targetDomain: "session", output: "silent" })
            expect(summary.completed).toBe(2)
          } finally {
            await restore()
          }

          const migrated = await Storage.read<Record<string, unknown>>(key)
          expect(Session.Info.safeParse(await Session.get(sessionID)).success).toBe(true)
          // `running` is the survivor; the binding itself is untouched, so
          // continue, abandon and the review controls still resolve the loop.
          expect(migrated.blueprint).toEqual({ loopID: "bll_legacy", loopRole: "execution", phase: "running" })
          // The stop the user asked for is not dropped with the status: it becomes
          // the session's own latch, which is what keeps the turn from resuming.
          expect(await SessionLifecycle.snapshot(sessionID)).toMatchObject({ reason: "workflow" })
          expect(await SessionLifecycle.blocksDrive(await Session.get(sessionID))).toBe(true)

          const entry = (await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)
          expect(entry).toBeDefined()
          expect(entry!.blueprint).toEqual({ loopID: "bll_legacy", loopRole: "execution", phase: "running" })

          await Session.remove(sessionID)
        },
      })
    }))

  test("re-running the conversion leaves the upgraded store unchanged", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const { sessionID, key } = await seedWaitingPhaseSession(scope)
          const phase = migrations.find((entry) => entry.id === PHASE_ID)
          const nav = migrations.find((entry) => entry.id === NAV_ID)
          expect(phase).toBeDefined()
          expect(nav).toBeDefined()

          await phase!.up(() => {})
          const first = await Storage.read<Record<string, unknown>>(key)
          await phase!.up(() => {})
          const second = await Storage.read<Record<string, unknown>>(key)

          // Byte-identical, including `since`: the latch is first-pause-wins, so a
          // second pass cannot churn the reason or the timestamp the user sees.
          expect(second).toEqual(first)
          expect((second.paused as Record<string, unknown>).since).toBe((first.paused as Record<string, unknown>).since)

          await nav!.up(() => {})
          await nav!.up(() => {})
          const entry = (await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)
          expect(entry?.blueprint?.phase).toBe("running")

          await Session.remove(sessionID)
        },
      })
    }))

  test("a fresh install and an ordinary Blueprint binding are untouched", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          // Fresh install: a new session, and a newly bound loop, are already in the
          // current shape and must gain no latch and no rewrite.
          const bound = await Session.create({ title: "Freshly bound Blueprint session" })
          await Session.update(bound.id, (draft) => {
            draft.blueprint = { loopID: "bll_fresh", loopRole: "execution", phase: "running" }
          })
          const plain = await Session.create({ title: "Fresh session" })
          const key = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(bound.id))
          const before = await Storage.read<Record<string, unknown>>(key)

          const phase = migrations.find((entry) => entry.id === PHASE_ID)!
          const nav = migrations.find((entry) => entry.id === NAV_ID)!
          await phase.up(() => {})
          await nav.up(() => {})

          expect(await Storage.read<Record<string, unknown>>(key)).toEqual(before)
          expect(await Session.get(bound.id)).toMatchObject({ blueprint: { phase: "running" } })
          expect((await Session.get(bound.id)).paused).toBeUndefined()
          expect((await Session.get(plain.id)).paused).toBeUndefined()
          expect(await Session.Info.safeParse(await Session.get(bound.id))).toMatchObject({ success: true })

          await Session.remove(bound.id)
          await Session.remove(plain.id)
        },
      })
    }))

  test("the rebuild clears a stale waiting phase left in an existing nav index", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const { sessionID, key } = await seedWaitingPhaseSession(scope)
          const nav = migrations.find((entry) => entry.id === NAV_ID)!

          // A store whose index was built before the change keeps the retired
          // member in its already-persisted index: reading an index does not
          // re-validate its entries, so the stale value reaches the client, whose
          // contract no longer admits it.
          const navKey = StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id))
          const index = await Storage.read<{ entries: Array<Record<string, unknown>> }>(navKey)
          await Storage.write(navKey, {
            ...index,
            entries: index.entries.map((entry) =>
              entry.id === sessionID ? { ...entry, blueprint: { loopID: "bll_legacy", phase: "waiting" } } : entry,
            ),
          })
          expect(
            (await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)?.blueprint?.phase,
          ).toBe("waiting" as never)

          const phase = migrations.find((entry) => entry.id === PHASE_ID)!
          await phase.up(() => {})
          await nav.up(() => {})

          expect(await Storage.read<Record<string, unknown>>(key)).toMatchObject({
            blueprint: { phase: "running" },
          })
          expect(
            (await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)?.blueprint?.phase,
          ).toBe("running")

          await Session.remove(sessionID)
        },
      })
    }))

  test("rebuilding the navigation index before the conversion drops the session", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const { sessionID, key } = await seedWaitingPhaseSession(scope)
          const phase = migrations.find((entry) => entry.id === PHASE_ID)!
          const nav = migrations.find((entry) => entry.id === NAV_ID)!

          // The order the declaration forbids, executed on purpose: the rebuild
          // reads canonical records, so a record that still fails `safeParse` is
          // skipped and the session disappears from the sidebar.
          await nav.up(() => {})
          expect((await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)).toBeUndefined()

          // The declared order recovers it, which is the whole reason the ordering
          // is declared rather than left to array position.
          await phase.up(() => {})
          await nav.up(() => {})
          expect((await SessionNav.readNavIndex(scope.id)).entries.find((e) => e.id === sessionID)).toBeDefined()
          expect(Session.Info.safeParse(await Session.get(sessionID)).success).toBe(true)

          await Session.remove(sessionID)
        },
      })
    }))

  test("the navigation rebuild is declared after the phase conversion", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: (await Scope.fromDirectory(tmp.path)).scope,
        fn: async () => {
          const nav = migrations.find((entry) => entry.id === NAV_ID)
          expect(nav?.dependsOn).toEqual([PHASE_ID])

          // The runner resolves order from `dependsOn`, and the resolved order is
          // what actually executes. Asserting on it rather than on array position
          // is the point: the rebuild must observe the converted record, because
          // executing it first re-derives indexes from a record that still fails
          // `safeParse` and re-drops the session the conversion exists to keep.
          await using migration = await migrationFixture({
            register: () => MigrationRegistry.register("session", migrations),
          })
          const pending = await migration.run(async () =>
            (await getMigrationStatus("session")).session.pending.map((entry) => entry.id),
          )
          const phaseIndex = pending.indexOf(PHASE_ID)
          const navIndex = pending.indexOf(NAV_ID)
          expect(phaseIndex).toBeGreaterThan(-1)
          expect(navIndex).toBeGreaterThan(-1)
          expect(phaseIndex).toBeLessThan(navIndex)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

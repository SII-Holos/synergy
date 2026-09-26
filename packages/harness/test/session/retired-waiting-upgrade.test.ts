import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"

const PAUSE_LATCH_ID = "20260920-session-pause-latch"
const WAITING_PHASE_ID = "20260920-session-blueprint-waiting-phase"

async function runMigration(id: string) {
  const migration = migrations.find((candidate) => candidate.id === id)
  if (!migration) throw new Error(`migration not found: ${id}`)
  await migration.up(() => {})
}

function storedKey(scopeID: string, sessionID: string) {
  return StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID))
}

/**
 * A store written before the workflow's own pause authority was retired can
 * carry *both* retired markers on the same session: the old `pendingReply` flag
 * and a `blueprint.phase` of `waiting`. Two migrations in this change then
 * target the same latch, and they must agree about it.
 *
 * Both facts were true at once in practice — the flag tracked an unanswered
 * reply while the loop held the session waiting — so the agreeing shape is the
 * realistic upgrade rather than a contrived one.
 */
async function seedBothRetiredMarkers(scopeID: string) {
  const session = await Session.create({ title: "Held with an unanswered reply" })
  const root = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    isRoot: true,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  const key = storedKey(scopeID, session.id)
  const stored = await Storage.read<Record<string, unknown>>(key)
  await Storage.write(key, {
    ...stored,
    pendingReply: true,
    blueprint: { loopID: "bll_held", loopRole: "execution", phase: "waiting" },
  })
  return { sessionID: session.id, key, rootID: root.id }
}

describe("retired waiting state upgrade", () => {
  test("one latch results when both retired markers describe the same stop", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const scopeID = ScopeContext.current.scope.id
          const { key } = await seedBothRetiredMarkers(scopeID)

          await runMigration(PAUSE_LATCH_ID)
          await runMigration(WAITING_PHASE_ID)

          const info = await Storage.read<Record<string, unknown>>(key)
          // The phase is carried forward, or the record fails `safeParse` and the
          // session is dropped from the navigation projection entirely.
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("running")
          // The retired flag is gone rather than rewritten.
          expect(info?.pendingReply).toBeUndefined()
          // Exactly one latch, and the cause recorded first wins: the flag
          // migration runs first and its reason is the accurate one — the runtime
          // stopped with a reply owed.
          expect(info?.paused).toMatchObject({ reason: "interrupted" })
        },
      })
    }))

  test("running the upgrade twice leaves the store byte-identical", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const scopeID = ScopeContext.current.scope.id
          const { key } = await seedBothRetiredMarkers(scopeID)

          await runMigration(PAUSE_LATCH_ID)
          await runMigration(WAITING_PHASE_ID)
          const upgraded = await Storage.read<Record<string, unknown>>(key)

          await runMigration(PAUSE_LATCH_ID)
          await runMigration(WAITING_PHASE_ID)

          // Nothing is left to convert, so a resumed or repeated bootstrap must
          // not churn `since` or rewrite a record it already carried forward.
          expect(await Storage.read<Record<string, unknown>>(key)).toEqual(upgraded)
        },
      })
    }))

  test("a waiting phase on its own still carries the loop-held stop onto the latch", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const scopeID = ScopeContext.current.scope.id
          const session = await Session.create({ title: "Held, no reply owed" })
          const key = storedKey(scopeID, session.id)
          const stored = await Storage.read<Record<string, unknown>>(key)
          await Storage.write(key, {
            ...stored,
            blueprint: { loopID: "bll_held", loopRole: "execution", phase: "waiting" },
          })

          await runMigration(WAITING_PHASE_ID)

          const info = await Storage.read<Record<string, unknown>>(key)
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("running")
          expect(info?.paused).toMatchObject({
            reason: "workflow",
            description: "Stopped by BlueprintLoop; continue or abandon",
          })
        },
      })
    }))

  test("a latch the session already owns is never rewritten by the upgrade", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const scopeID = ScopeContext.current.scope.id
          const session = await Session.create({ title: "Already stopped by the user" })
          const key = storedKey(scopeID, session.id)
          const stored = await Storage.read<Record<string, unknown>>(key)
          const ownLatch = { reason: "aborted", description: "Turn stopped mid-work", since: 1234 }
          await Storage.write(key, {
            ...stored,
            paused: ownLatch,
            blueprint: { loopID: "bll_held", loopRole: "execution", phase: "waiting" },
          })

          await runMigration(WAITING_PHASE_ID)

          const info = await Storage.read<Record<string, unknown>>(key)
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("running")
          // First pause wins: the user's own stop, including its `since`, survives
          // the upgrade that only exists to carry the record forward.
          expect(info?.paused).toEqual(ownLatch)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

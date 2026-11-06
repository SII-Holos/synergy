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
 * and a `blueprint.phase` of `waiting`. Core owns only the pending-reply
 * conversion; the unregistered Blueprint record must remain untouched.
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

describe("core retired reply upgrade preserves unavailable workflow data", () => {
  test("the reply latch upgrades without rewriting the unregistered Blueprint phase", () =>
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
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("waiting")
          // The retired flag is gone rather than rewritten.
          expect(info?.pendingReply).toBeUndefined()
          // The session flag alone owns this stop: the runtime owed a reply.
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

  test("a historical owner phase alone cannot pause an ordinary session without its owner", () =>
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
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("waiting")
          expect(info?.paused).toBeUndefined()
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
          expect((info?.blueprint as { phase?: string } | undefined)?.phase).toBe("waiting")
          // First pause wins: the user's own stop, including its `since`, survives
          // the upgrade that only exists to carry the record forward.
          expect(info?.paused).toEqual(ownLatch)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

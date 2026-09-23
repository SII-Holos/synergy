import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionLifecycle } from "../../src/session/lifecycle"

/** A root user message with no terminal assistant after it is exactly the
 *  evidence startup reconciliation looks for, so the fixture reproduces the
 *  observable shape of an interrupted turn without running a real one. */
async function createInterruptedTurn(sessionID: string) {
  // `isRoot: true` is what makes this the reply-required root; without it the
  // message models a no-reply notification, which has no reply cycle to leave
  // unfinished and is therefore not the evidence this scan looks for.
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot: true,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

describe("SessionLifecycle pause latch", () => {
  test("concurrent pauses retain the first persisted reason", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Concurrent pause" })
          const results = await Promise.all([
            SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" }),
            SessionLifecycle.pause({ sessionID: session.id, reason: "failed" }),
          ])
          expect(results.filter(Boolean)).toHaveLength(1)
          expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe(results[0] ? "aborted" : "failed")
          expect((await Session.get(session.id)).time.updated).toBe(session.time.updated)
        },
      })
    }))

  test.each(["aborted", "failed", "interrupted", "workflow"] as const)(
    "pause records %s once without recording activity",
    (reason) =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({ title: "Pausable" })

            expect(await SessionLifecycle.pause({ sessionID: session.id, reason })).toBe(true)
            const first = await SessionLifecycle.snapshot(session.id)
            expect(first?.reason).toBe(reason)
            expect(first?.since).toBeNumber()
            expect((await Session.get(session.id)).time.updated).toBe(session.time.updated)

            // First pause wins: a second reason describes the same stoppage, so
            // rewriting it would churn `since` and lose the original cause.
            expect(await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })).toBe(false)
            expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe(reason)
            expect((await SessionLifecycle.snapshot(session.id))?.since).toBe(first?.since)
          },
        })
      }),
  )

  test("machine sessions and archived sessions never latch", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          // An unattended session is driven by a domain that reconciles its own
          // work, so a user-facing pause would be both invisible and disobeyed.
          const machine = await Session.create({
            title: "Machine",
            interaction: SessionInteraction.unattended("agenda"),
          })
          expect(await SessionLifecycle.pause({ sessionID: machine.id, reason: "failed" })).toBe(false)
          expect(await SessionLifecycle.snapshot(machine.id)).toBeUndefined()

          const archived = await Session.create({ title: "Archived" })
          await Session.update(archived.id, (draft) => {
            draft.time.archived = Date.now()
          })
          expect(await SessionLifecycle.pause({ sessionID: archived.id, reason: "failed" })).toBe(false)
          expect(await SessionLifecycle.snapshot(archived.id)).toBeUndefined()
        },
      })
    }))

  test("clear releases the latch once and reports whether one was present", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Clearable" })
          expect(await SessionLifecycle.clear(session.id)).toBe(false)

          await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          expect(await SessionLifecycle.clear(session.id)).toBe(true)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
          expect(await SessionLifecycle.clear(session.id)).toBe(false)
        },
      })
    }))

  test("blocksDrive gates interactive sessions only", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const interactive = await Session.create({ title: "Interactive" })
          const machine = await Session.create({
            title: "Machine",
            interaction: SessionInteraction.unattended("channel"),
          })

          expect(await SessionLifecycle.blocksDrive(await Session.get(interactive.id))).toBe(false)
          await SessionLifecycle.pause({ sessionID: interactive.id, reason: "aborted" })
          expect(await SessionLifecycle.blocksDrive(await Session.get(interactive.id))).toBe(true)

          // A machine session is never gated even if a latch somehow exists, so
          // the reader applies the same rule the writer does.
          const forced = await Session.get(machine.id)
          forced!.paused = { reason: "aborted", since: Date.now() }
          expect(await SessionLifecycle.blocksDrive(forced)).toBe(false)
          expect(await SessionLifecycle.blocksDrive(undefined)).toBe(false)
        },
      })
    }))
})

describe("SessionLifecycle.listUnfinishedSessions", () => {
  test("finds interrupted, queued and already-paused sessions, excluding machine sessions", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const project = await tmp.scope()
      await ScopeContext.provide({
        scope: project,
        fn: async () => {
          const interrupted = await Session.create({ title: "Interrupted" })
          await createInterruptedTurn(interrupted.id)

          const finished = await Session.create({ title: "Finished" })

          const paused = await Session.create({ title: "Already paused" })
          await createInterruptedTurn(paused.id)
          await SessionLifecycle.pause({ sessionID: paused.id, reason: "aborted" })

          const machine = await Session.create({
            title: "Machine",
            interaction: SessionInteraction.unattended("boss"),
          })
          await createInterruptedTurn(machine.id)

          const queued = await Session.create({ title: "Queued work" })
          await SessionInbox.enqueueUser({
            sessionID: queued.id,
            model: { providerID: "test", modelID: "test" },
            parts: [{ type: "text", text: "queued request" }],
          })

          const found = await SessionLifecycle.listUnfinishedSessions(project.id)
          expect(found).toContain(interrupted.id)
          expect(found).toContain(queued.id)
          // A paused session can still have orphaned tool parts to settle.
          expect(found).toContain(paused.id)
          // A machine session is never paused, so it must not be reported here.
          expect(found).not.toContain(machine.id)
          // A turn with a terminal assistant has nothing left to reconcile.
          expect(found).not.toContain(finished.id)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

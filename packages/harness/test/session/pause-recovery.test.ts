import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionPauseRecovery } from "../../src/session/pause-recovery"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionProgress } from "../../src/session/progress"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { Lock } from "../../src/util/lock"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("recovery enrollment rolls back with its write and an old receipt cannot erase newer work", () =>
  runtime.run(async () => {
    const owner = { scopeID: "home", sessionID: Identifier.ascending("session") }
    await expect(
      Storage.transaction(async () => {
        await SessionPauseRecovery.mark(owner)
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect(await SessionPauseRecovery.revision(owner)).toBeUndefined()
    await SessionPauseRecovery.mark(owner)
    const first = (await SessionPauseRecovery.revision(owner))!
    await SessionPauseRecovery.mark(owner)
    await SessionPauseRecovery.complete(owner, first)
    const current = (await SessionPauseRecovery.revision(owner))!
    expect(current).not.toBe(first)
    await SessionPauseRecovery.complete(owner, current)
    expect(await SessionPauseRecovery.revision(owner)).toBeUndefined()
  }))

test("first historical access reconciles its owner and recovery yields to an active human control operation", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const owner = { scopeID: session.scope.id, sessionID: session.id }
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "test", modelID: "test" },
        })
        await SessionPauseRecovery.complete(owner, (await SessionPauseRecovery.revision(owner))!)
        await Storage.remove([
          "sessions",
          owner.scopeID,
          owner.sessionID,
          "migrations",
          "session",
          "20261010-session-pause-recovery-candidates",
        ])
        await SessionInvoke.reconcilePausedSessions(owner.scopeID)
        expect(
          (await Storage.read<Session.Info>(["sessions", owner.scopeID, owner.sessionID, "info"])).paused,
        ).toBeUndefined()
        {
          using control = await Lock.write(`session-control:${session.id}`)
          expect(await SessionPauseRecovery.revision(owner)).toBeUndefined()
          await SessionInvoke.reconcilePausedSession(session.id)
          expect(await SessionPauseRecovery.revision(owner)).toBeUndefined()
        }
        await SessionInvoke.reconcilePausedSession(session.id)
        expect((await Session.get(session.id)).paused?.reason).toBe("interrupted")
        expect(await SessionPauseRecovery.revision(owner)).toBeUndefined()
      },
    })
  }))

test.each([false, true])(
  "pending reply preserves the compaction boundary (valid=%s) without old body hydration",
  (valid) =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const user = async (created: number, isRoot: boolean) =>
            Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID: session.id,
              role: "user",
              isRoot,
              time: { created },
              agent: "general",
              model: { providerID: "test", modelID: "test" },
            })
          const root = await user(1, true)
          const boundary = await user(2, false)
          if (valid)
            await Session.updatePart({
              type: "compaction",
              auto: false,
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: boundary.id,
            })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: boundary.id,
            summary: true,
            finish: "stop",
            time: { created: 3, completed: 4 },
            agent: "general",
            mode: "general",
            providerID: "test",
            modelID: "test",
            cost: 0,
            path: { cwd: tmp.path, root: tmp.path },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await user(5, false)
          const expected = SessionProgress.pendingReply(
            await MessageV2.filterCompacted(MessageV2.stream({ sessionID: session.id })),
          )
          using bodies = spyOn(MessageV2, "parts")
          expect(await SessionProgress.pendingReplyFor({ scopeID: session.scope.id, sessionID: session.id })).toBe(
            expected,
          )
          expect(expected).toBe(!valid)
          expect(bodies.mock.calls.some(([input]) => input.messageID === root.id)).toBe(false)
          await SessionLifecycle.completeRecoveryIfSettled(session.id)
          expect(await SessionPauseRecovery.revision({ scopeID: session.scope.id, sessionID: session.id })).toEqual(
            valid ? undefined : expect.any(String),
          )
        },
      })
    }),
)

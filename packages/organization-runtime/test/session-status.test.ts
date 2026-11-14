import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { currentRunID, observeSessionStatus } from "../src/session-status"

async function root(sessionID: string, isRoot = true) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot,
    agent: "general",
    model: { providerID: "fixture", modelID: "model" },
    time: { created: Date.now() },
  })
}

test("a cold paused Session exposes the native unfinished root for cancellation without reopening work", async () => {
  await using home = await tmpdir()
  const first = await testRuntime({ home: home.path })
  const stored = await first.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const input = await root(session.id)
        const owner = RolloutLifecycle.owner(session)
        await RolloutLedger.beginRun(owner, input.id)
        await RolloutLedger.finishRun(owner, input.id, "interrupted")
        await root(session.id, false)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        return { sessionID: session.id, runID: input.id, owner }
      },
    }),
  )
  await first.close()
  await using second = await testRuntime({ home: home.path })
  await second.run(async () => {
    const session = await Session.get(stored.sessionID)
    expect(SessionManager.getRuntime(session.id)?.owner).toBeUndefined()
    expect(await SessionInbox.latestRootID(session.id)).toBe(stored.runID)
    expect(await observeSessionStatus(session, "status-organization")).toMatchObject({
      type: "paused",
      runID: stored.runID,
      since: session.paused?.since,
    })
    expect((await RolloutLedger.getRun(stored.owner, stored.runID)).status).toBe("interrupted")
    await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: () => RolloutLifecycle.cancel(session.id, stored.runID),
    })
    expect((await RolloutLedger.getRun(stored.owner, stored.runID)).status).toBe("cancelled")
    expect((await observeSessionStatus(await Session.get(session.id), "status-organization")).runID).toBeUndefined()
  })
}, 15_000)

test("paused status retains an unopened canonical root and never substitutes a context message", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        expect(await currentRunID(session)).toBeUndefined()
        const input = await root(session.id)
        await root(session.id, false)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "failed" })
        const paused = await Session.get(session.id)
        expect(await currentRunID(paused, { type: "paused", ...paused.paused! })).toBe(input.id)
        await RolloutLifecycle.cancel(session.id, input.id)
        expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), input.id)).status).toBe("cancelled")
        expect(await currentRunID(await Session.get(session.id), { type: "paused", ...paused.paused! })).toBeUndefined()
      },
    }),
  )
})

test("live execution and retry identities precede historical root selection", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const input = await root(session.id)
        const later = await root(session.id)
        const lease = SessionManager.acquire(session.id)!
        try {
          SessionManager.bindRootTask(lease, input.id)
          expect(await SessionInbox.latestRootID(session.id)).toBe(later.id)
          expect(await currentRunID(session)).toBe(input.id)
        } finally {
          await SessionManager.release(lease)
        }
        expect(
          await currentRunID(session, {
            type: "retry",
            rootID: input.id,
            messageID: input.id,
            phase: "waiting",
            attempt: 1,
            message: "Waiting for model",
            error: "Temporary failure",
            startedAt: Date.now(),
            canRetry: true,
          }),
        ).toBe(input.id)
        expect(await currentRunID(session, { type: "idle" })).toBeUndefined()
      },
    }),
  )
})

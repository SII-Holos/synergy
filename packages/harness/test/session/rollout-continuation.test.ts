import { expect, spyOn, test } from "bun:test"
import { fixture } from "../support/rollout"
import { SessionInbox } from "../../src/session/inbox"
import { SessionHistory } from "../../src/session/history"
import { RolloutContinuationRecovery } from "../../src/session/rollout/continuation-recovery"
import { SessionProgress } from "../../src/session/progress"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"

async function notify(sessionID: string, rootID: string) {
  await SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    noReply: true,
    parts: [{ type: "text", text: "Child task completed" }],
  })
  for (const item of await SessionInbox.drainSteer(sessionID))
    await SessionInbox.materializeItem(item, rootID, { guiding: true })
}

test("a materialized continuation keeps its rollout open", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
    await notify(session.id, rootID)
    expect(await SessionInbox.list(session.id)).toHaveLength(0)
    expect(SessionProgress.needsModelCall(await SessionHistory.modelMessages({ sessionID: session.id }), rootID)).toBe(
      true,
    )
    await RolloutLifecycle.reconcile(session.id, rootID)
    expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("running")
  })
})

for (const status of ["completed", "cancelled", "failed"] as const) {
  test(`upgrade handles ${status} rollout with an unanswered continuation`, async () => {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
      const before = await RolloutLedger.finishRun(call.owner, rootID, status)
      await notify(session.id, rootID)
      const queued = await SessionInbox.enqueueUser({
        sessionID: session.id,
        model: { providerID: "test", modelID: "test" },
        parts: [{ type: "text", text: "Next task" }],
      })
      const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
      await RolloutContinuationMigration.session(call.owner)
      const expected = status === "completed" ? { ...before, status: "interrupted" as const } : before
      expect(await RolloutLedger.getRun(call.owner, rootID)).toEqual(expected)
      expect(await RolloutContinuationRecovery.pending(session.id)).toBe(status === "completed")
      expect(await RolloutContinuationRecovery.list(call.owner.scopeID)).toEqual(
        status === "completed" ? [session.id] : [],
      )
      await RolloutContinuationMigration.session(call.owner)
      expect(await RolloutLedger.getRun(call.owner, rootID)).toEqual(expected)
      expect((await SessionInbox.peekTask(session.id))?.id).toBe(queued.id)
      if (status === "completed") {
        const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
        expect(segment.status).toBe("running")
        await RolloutLedger.finishSegment(segment, "completed")
      }
    })
  })
}

test("upgrade preserves a completed rollout whose latest input already has a reply", async () => {
  await fixture(async ({ rootID, call }) => {
    await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
    const before = await RolloutLedger.finishRun(call.owner, rootID, "completed")
    const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
    await RolloutContinuationMigration.session(call.owner)
    expect(await RolloutLedger.getRun(call.owner, rootID)).toEqual(before)
  })
})

test("startup runs continuation repair once through the registered migration", async () => {
  const { migrations } = await import("../../src/session/migration")
  const { runMigrations } = await import("../../src/migration")
  const { Storage } = await import("../../src/storage/storage")
  const { StoragePath } = await import("../../src/storage/path")
  const id = "20260910-rollout-unanswered-continuation"
  const tracking = StoragePath.metaMigrationLogDomain("session")
  const previous = await Storage.read<Record<string, number>>(tracking).catch((error) => {
    if (error instanceof Storage.NotFoundError) return undefined
    throw error
  })
  try {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      await notify(session.id, rootID)
      await Storage.write(
        tracking,
        Object.fromEntries(migrations.filter((entry) => entry.id !== id).map((entry) => [entry.id, 1])),
      )
      expect((await runMigrations({ targetDomain: "session", output: "silent" })).completed).toBe(1)
      expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("interrupted")
      expect((await runMigrations({ targetDomain: "session", output: "silent" })).completed).toBe(0)
    })
  } finally {
    if (previous) await Storage.write(tracking, previous)
    else await Storage.remove(tracking)
  }
})

for (const status of ["cancelled", "failed"] as const) {
  test(`recovery stops retrying a repaired rollout that becomes ${status}`, async () => {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      await notify(session.id, rootID)
      const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
      await RolloutContinuationMigration.session(call.owner)
      expect(await RolloutContinuationRecovery.pending(session.id)).toBe(true)
      expect(await RolloutContinuationRecovery.pending(session.id)).toBe(true)
      const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await RolloutLedger.finishSegment(segment, status)
      await RolloutLedger.finishRun(call.owner, rootID, status)
      expect(await RolloutContinuationRecovery.pending(session.id)).toBe(false)
      expect(await RolloutContinuationRecovery.list(call.owner.scopeID)).toEqual([])
    })
  })
}

test("startup recovery leaves ordinary interrupted work for explicit user resume", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
    await RolloutLedger.finishRun(call.owner, rootID, "interrupted")
    await notify(session.id, rootID)
    const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
    await RolloutContinuationMigration.session(call.owner)
    expect(await RolloutContinuationRecovery.pending(session.id)).toBe(false)
    expect(await RolloutContinuationRecovery.list(call.owner.scopeID)).toEqual([])
  })
})

test("migration retries a state-write failure without losing the recovery intent", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
    await RolloutLedger.finishRun(call.owner, rootID, "completed")
    await notify(session.id, rootID)
    const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
    const { RolloutJournal } = await import("../../src/session/rollout/journal")
    {
      using write = spyOn(RolloutJournal, "write").mockRejectedValueOnce(new Error("Write interrupted"))
      await expect(RolloutContinuationMigration.session(call.owner)).rejects.toThrow("Write interrupted")
    }
    expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("completed")
    await RolloutContinuationMigration.session(call.owner)
    expect(await RolloutContinuationRecovery.pending(session.id)).toBe(true)
  })
})

test("archived recovery stays dormant until the session is restored", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
    await RolloutLedger.finishRun(call.owner, rootID, "completed")
    await notify(session.id, rootID)
    const { RolloutContinuationMigration } = await import("../../src/session/rollout/continuation-migration")
    const { Session } = await import("../../src/session")
    await RolloutContinuationMigration.session(call.owner)
    await Session.update(session.id, (draft) => {
      draft.time.archived = Date.now()
    })
    expect(await RolloutContinuationRecovery.list(call.owner.scopeID)).toEqual([])
    await Session.update(session.id, (draft) => {
      draft.time.archived = undefined
    })
    expect(await RolloutContinuationRecovery.list(call.owner.scopeID)).toEqual([session.id])
  })
})

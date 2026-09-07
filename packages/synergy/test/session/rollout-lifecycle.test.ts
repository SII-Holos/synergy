import { expect, test } from "bun:test"
import { fixture, complete } from "../fixture/rollout"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { SessionManager } from "../../src/session/manager"

test("a task remains open until its child result is durably settled", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await complete(call)
    const root = await MessageV2.get({ sessionID: session.id, messageID: rootID })
    if (root.info.role !== "user") throw new Error("Expected root user")
    const segment = await RolloutLifecycle.start(session, root.info, root.parts)
    const child = await Session.create({
      parentID: session.id,
      cortex: {
        taskID: Identifier.ascending("cortex"),
        parentSessionID: session.id,
        parentMessageID: (await Session.messages({ sessionID: session.id })).at(-1)!.info.id,
        description: "child",
        agent: "synergy",
        startedAt: Date.now(),
        status: "completed",
      },
    })
    await RolloutLedger.finishSegment(segment, "completed")
    expect((await RolloutLifecycle.reconcile(session.id, rootID))?.status).toBe("running")
    await Session.update(child.id, (draft) => {
      draft.cortex!.settledAt = Date.now()
    })
    expect((await RolloutLifecycle.reconcile(session.id, rootID))?.status).toBe("completed")
  })
})

test("Plan mode is not unfinished autonomous work; active Light Loop is", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await complete(call)
    await Session.update(session.id, (draft) => {
      draft.workflow = { kind: "lightloop", instructions: "task" }
    })
    expect((await RolloutLifecycle.reconcile(session.id, rootID))?.status).toBe("running")
    await Session.update(session.id, (draft) => {
      draft.workflow = { kind: "plan" }
    })
    expect((await RolloutLifecycle.reconcile(session.id, rootID))?.status).toBe("completed")
  })
})

test("cancelling a queued run does not abort another root owning the same session", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await complete(call)
    const owner = RolloutLifecycle.owner(session)
    const queued = Identifier.ascending("message")
    await RolloutLedger.beginRun(owner, queued)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const running = SessionManager.run(session.id, async (lease) => {
      SessionManager.bindRootTask(lease, rootID)
      entered.resolve()
      await release.promise
      expect(lease.signal.aborted).toBe(false)
    })
    await entered.promise
    try {
      expect((await RolloutLifecycle.cancel(session.id, queued)).status).toBe("cancelled")
      expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("running")
      await expect(RolloutLedger.beginRun(owner, queued)).rejects.toThrow("cancelled")
    } finally {
      release.resolve()
      await running
    }
  })
})

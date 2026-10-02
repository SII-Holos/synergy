import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { SessionInbox } from "../../src/session/inbox"
import { SessionHistory } from "../../src/session/history"
import { SessionProgress } from "../../src/session/progress"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { afterAll as afterRuntimeTests } from "bun:test"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

/**
 * The only continuation behavior that survived the removal of automatic
 * recovery: a steering notification materialized into the transcript leaves the
 * run open until the model answers it. `RolloutContinuationRecovery` and
 * `RolloutContinuationMigration` are gone, so the tests that exercised them are
 * gone with them.
 */
async function notify(sessionID: string, rootID: string) {
  await SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    noReply: true,
    parts: [{ type: "text", text: "Child task completed" }],
  })
  for (const item of await SessionInbox.peekSteer(sessionID))
    await SessionInbox.materializeItem(item, rootID, { guiding: true })
}

test("a materialized continuation keeps its rollout open", () =>
  runtime.run(async () => {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
      await notify(session.id, rootID)
      expect(await SessionInbox.list(session.id)).toHaveLength(0)
      expect(
        SessionProgress.needsModelCall(await SessionHistory.modelMessages({ sessionID: session.id }), rootID),
      ).toBe(true)
      await RolloutLifecycle.reconcile(session.id, rootID)
      expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("running")
    })
  }))

afterRuntimeTests(() => runtime.close())

test("a newer root reply closes an older acknowledged continuation without fabricating its result", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed" })
      await notify(session.id, rootID)
      const messages = await SessionHistory.modelMessages({ sessionID: session.id })
      const oldRoot = messages.find((message) => message.info.id === rootID)!.info
      const oldReply = messages.find((message) => message.info.role === "assistant")!.info
      if (oldRoot.role !== "user" || oldReply.role !== "assistant") throw new Error("Fixture messages are missing")
      const next = Identifier.ascending("message")
      await Session.updateMessage({ ...oldRoot, id: next, rootID: next, time: { created: Date.now() } })
      await RolloutLifecycle.reconcile(session.id, rootID)
      expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("running")
      await Session.updateMessage({
        ...oldReply,
        id: Identifier.ascending("message"),
        parentID: next,
        rootID: next,
        time: { created: Date.now(), completed: Date.now() },
      })
      await RolloutLifecycle.reconcile(session.id, rootID)
      expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("completed")
    }),
  ))

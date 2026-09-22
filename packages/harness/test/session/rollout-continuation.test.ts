import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { SessionInbox } from "../../src/session/inbox"
import { SessionHistory } from "../../src/session/history"
import { SessionProgress } from "../../src/session/progress"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { afterAll as afterRuntimeTests } from "bun:test"
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

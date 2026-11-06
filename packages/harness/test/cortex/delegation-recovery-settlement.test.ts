import { afterAll, expect, test } from "bun:test"
import { complete, fixture } from "../support/rollout"
import { testRuntime } from "../support/runtime"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { RolloutLedger } from "../../src/session/rollout/ledger"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("recovery settles a delegation that was delivered before the restart", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await complete(call)
      const child = await Session.create({
        parentID: session.id,
        cortex: {
          taskID: "delegation-recovery",
          parentSessionID: session.id,
          parentMessageID: rootID,
          description: "Delegation interrupted by a restart",
          agent: "test",
          startedAt: Date.now() - 1_000,
          completedAt: Date.now(),
          deliveryNotifiedAt: Date.now(),
          notifyParentOnComplete: true,
          status: "interrupted",
        },
      })
      try {
        expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("running")

        await Cortex.reconcileParentNotifications(session.scope.id)

        expect((await Session.get(child.id)).cortex?.settledAt).toBeDefined()
        expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("completed")
      } finally {
        await Session.remove(child.id)
      }
    }),
  ))

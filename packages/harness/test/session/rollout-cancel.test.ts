import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("abandoning after recovery settles an interrupted run with an idempotent cancellation", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await RolloutRecovery.owner(call.owner)
      const result = await RolloutLifecycle.cancel(session.id, rootID)
      expect(result.status).toBe("cancelled")
      expect(result.cancelRequestedAt).toBeNumber()
      expect(await RolloutLifecycle.cancel(session.id, rootID)).toEqual(result)
      await expect(RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })).rejects.toThrow(
        "cancelled",
      )
    }),
  ))

test("cancellation settles orphaned calls after the execution owner has released", () =>
  runtime.run(async () => {
    await fixture(async ({ session, rootID, call }) => {
      expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("running")
      const cancelled = await RolloutLifecycle.cancel(session.id, rootID)
      expect(cancelled.status).toBe("cancelled")
      const calls = await RolloutLedger.calls(call.owner, rootID)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ id: call.id, status: "interrupted" })
      expect(await RolloutLifecycle.cancel(session.id, rootID)).toEqual(cancelled)
      expect(await RolloutLedger.calls(call.owner, rootID)).toEqual(calls)
    })
  }))

test("cancellation does not rewrite call evidence while an execution segment is active", () =>
  runtime.run(async () => {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await expect(RolloutLifecycle.cancel(session.id, rootID)).rejects.toThrow("active segments")
      expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("running")
    })
  }))

afterRuntimeTests(() => runtime.close())

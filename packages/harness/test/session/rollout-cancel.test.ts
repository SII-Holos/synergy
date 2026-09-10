import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"

test("cancellation settles orphaned calls after the execution owner has released", async () => {
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
})

test("cancellation does not rewrite call evidence while an execution segment is active", async () => {
  await fixture(async ({ session, rootID, call }) => {
    await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
    await expect(RolloutLifecycle.cancel(session.id, rootID)).rejects.toThrow("active segments")
    expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("running")
  })
})

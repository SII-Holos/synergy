import { expect, test } from "bun:test"
import { RolloutOperation } from "../../src/session/rollout/operation"
import { RolloutContext } from "../../src/session/rollout/context"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutAccounting } from "../../src/session/rollout/accounting"
import type { RolloutSchema } from "../../src/session/rollout/schema"

test("failed request preparation terminates its independent run before any provider call", async () => {
  let owner: RolloutSchema.Owner | undefined
  const failure = new Error("input unavailable")
  await expect(
    RolloutOperation.execute(
      {
        independent: true,
        purpose: "prepare",
        model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
        request: async (value) => {
          owner = value
          throw failure
        },
      },
      async () => {
        throw new Error("provider must not run")
      },
    ),
  ).rejects.toBe(failure)
  const snapshot = await RolloutSnapshot.read(owner!)
  expect(snapshot.runs[0].status).toBe("failed")
  expect(snapshot.calls).toHaveLength(0)
})

test("concurrent non-chat calls retain their causal task and local work has no provider charge", async () => {
  const model = { providerID: "local", modelID: "test", sdk: "transformers", pricing: null }
  const identities = ["a", "b"].map((runID) => ({
    owner: { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() },
    runID,
  }))
  await Promise.all(
    identities.map((identity) =>
      RolloutContext.provide(identity, async () => {
        await RolloutLedger.beginRun(identity.owner, identity.runID)
        await RolloutOperation.execute(
          { purpose: "embedding", kind: "embedding", execution: "local", model, request: { text: identity.runID } },
          async () => {
            await Bun.sleep(1)
            expect(RolloutContext.current()?.runID).toBe(identity.runID)
            return { value: [1, 2], response: { vector: [1, 2] } }
          },
        )
        const snapshot = await RolloutSnapshot.read(identity.owner)
        expect(snapshot.calls).toHaveLength(1)
        expect(snapshot.calls[0].runID).toBe(identity.runID)
        expect(RolloutAccounting.summarize(snapshot).apiEstimate).toEqual({ known: 0, total: 0, unknown: 0 })
      }),
    ),
  )
})

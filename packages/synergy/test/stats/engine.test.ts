import { expect, test } from "bun:test"
import { Engine } from "../../src/stats/engine"
import { StatsStorage } from "../../src/stats/storage"
import { fixture, complete } from "../fixture/rollout"

test("refreshes a cached digest after an auxiliary attempt without a session timestamp change", async () => {
  await fixture(async ({ session, call }) => {
    await Engine.update()
    const before = await StatsStorage.getDigest(session.id)
    expect(before?.accounting?.apiEstimate.unknown).toBe(1)
    await complete(call)
    await Engine.get()
    const after = await StatsStorage.getDigest(session.id)
    expect(after?.updated).toBe(before?.updated)
    expect(after?.accounting?.attempts).toBe(1)
    expect(after?.cost).toBeCloseTo(0.0105)
    expect(after?.rolloutRevision).toBeGreaterThan(before!.rolloutRevision!)
  })
})

test("independent operations contribute cost and model usage without creating sessions", async () => {
  const { RolloutLedger } = await import("../../src/session/rollout/ledger")
  const { RolloutArtifact } = await import("../../src/session/rollout/artifact")
  const { Storage } = await import("../../src/storage/storage")
  await fixture(async ({ session, call }) => {
    const before = await Engine.update()
    const owner = { kind: "operation" as const, scopeID: session.scope.id, operationID: crypto.randomUUID() }
    try {
      const operation = await RolloutLedger.beginCall({
        owner,
        runID: "probe",
        purpose: "probe",
        model: call.model,
        request: {},
      })
      await complete(operation)
      await RolloutLedger.finishRun(owner, "probe", "completed")
      const after = await Engine.update()
      expect(after.overview.totalSessions).toBe(before.overview.totalSessions)
      expect(after.tokenCost.cost - before.tokenCost.cost).toBeCloseTo(0.0105)
      expect(after.tokenCost.accounting!.attempts - before.tokenCost.accounting!.attempts).toBe(1)
      const model = after.models.models.find((model) => model.modelID === "test")!
      const old = before.models.models.find((model) => model.modelID === "test")!
      expect(model.cost - old.cost).toBeCloseTo(0.0105)
      const repeated = await Engine.update()
      expect(repeated.tokenCost.cost).toBe(after.tokenCost.cost)
    } finally {
      await Storage.removeTree(RolloutArtifact.root(owner))
      await Engine.update()
    }
  })
})

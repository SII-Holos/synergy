import { afterEach, beforeEach, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutPending } from "../../src/session/rollout/pending"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import type { RolloutSchema } from "../../src/session/rollout/schema"

function owner(): RolloutSchema.Owner {
  return { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
}

function runKey(target: RolloutSchema.Owner) {
  return [...RolloutArtifact.root(target), "runs", "run", "info"]
}

// The pending ledger is global durable state within a test home; restore a
// clean slate after every test so sibling files in the same process are not
// poisoned by deliberately corrupted fixtures.
afterEach(() => Storage.remove(StoragePath.rolloutRecoveryPending()))
beforeEach(() => RolloutPending.markClean())

test("writes before first recovery preserve exhaustive discovery of historical owners", async () => {
  const historical = owner()
  const migrated = owner()
  await RolloutLedger.beginSegment({ owner: historical, runID: "run", input: { task: "historical" } })
  await Storage.remove(StoragePath.rolloutRecoveryPending())
  await RolloutLedger.beginSegment({ owner: migrated, runID: "run", input: { task: "migration" } })
  expect(await RolloutPending.tracked()).toBeUndefined()
  await RolloutRecovery.all()
  expect((await RolloutSnapshot.read(historical)).segments[0].status).toBe("interrupted")
  expect((await RolloutSnapshot.read(migrated)).segments[0].status).toBe("interrupted")
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
})

test("journal writes track their owner in the durable pending set before mutating", async () => {
  const operationID = crypto.randomUUID()
  const target: RolloutSchema.Owner = { kind: "operation", scopeID: "test", operationID }
  await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
  expect((await RolloutPending.tracked())?.owners).toContainEqual(target)
  await RolloutLedger.beginSegment({ owner: target, runID: "run-2", input: { task: "more" } })
  const pending = await RolloutPending.tracked()
  expect(
    pending?.owners.filter((entry) => entry.kind === "operation" && entry.operationID === operationID),
  ).toHaveLength(1)
})

test("a clean pending set recovers nothing and checks no owners", async () => {
  await RolloutPending.markClean()
  const seen: number[] = []
  await RolloutRecovery.all((current) => seen.push(current))
  expect(seen).toEqual([0])
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
})

test("a tracked owner recovers through the pending set and re-arms it", async () => {
  const target = owner()
  await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("running")
  const seen: number[] = []
  await RolloutRecovery.all((current) => seen.push(current))
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
  expect(seen[0]).toBe(0)
  expect(seen.at(-1)).toBeGreaterThan(0)
})

test("an untracked home falls back to the exhaustive scan and re-arms", async () => {
  const target = owner()
  await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
  await Storage.remove(StoragePath.rolloutRecoveryPending())
  await RolloutRecovery.all()
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
})

test("a malformed pending set falls back to the exhaustive scan", async () => {
  const target = owner()
  await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
  await Storage.write(StoragePath.rolloutRecoveryPending(), { version: 1, owners: [{ kind: "bogus" }] })
  await RolloutRecovery.all()
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
})

test("settle settles listed owners and re-arms the ledger after a drained shutdown", async () => {
  const target = owner()
  await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("running")
  await RolloutRecovery.settle()
  expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
  expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
})

test("settle is a no-op without a trusted ledger", async () => {
  await Storage.remove(StoragePath.rolloutRecoveryPending())
  await RolloutRecovery.settle()
  expect(await RolloutPending.tracked()).toBeUndefined()
})

test("settle leaves an untrusted ledger untouched", async () => {
  await Storage.write(StoragePath.rolloutRecoveryPending(), { version: 1, owners: [{ kind: "bogus" }] })
  await RolloutRecovery.settle()
  expect(
    await Storage.read<{ version: 1; owners: Array<{ kind: string }> }>(StoragePath.rolloutRecoveryPending()),
  ).toEqual({
    version: 1,
    owners: [{ kind: "bogus" }],
  })
})

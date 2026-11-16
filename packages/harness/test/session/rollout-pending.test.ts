import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { RolloutPending } from "../../src/session/rollout/pending"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import type { RolloutSchema } from "../../src/session/rollout/schema"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function owner(): RolloutSchema.Owner {
  return { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
}

function runKey(target: RolloutSchema.Owner) {
  return [...RolloutArtifact.root(target), "runs", "run", "info"]
}

test("unknown recovery coverage leaves cold owners untouched and fences only the selected owner", () =>
  runtime.run(async () => {
    const selected = owner()
    const cold = owner()
    await RolloutLedger.beginSegment({ owner: selected, runID: "run", input: {} })
    await RolloutLedger.beginSegment({ owner: cold, runID: "run", input: {} })
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    const scan = spyOn(Storage, "scan")
    try {
      await RolloutRecovery.all()
      expect(scan).not.toHaveBeenCalled()
      expect(await Storage.read(runKey(cold))).toMatchObject({ status: "running" })
      await RolloutLedger.beginSegment({ owner: selected, runID: "next", input: {} })
      expect(await Storage.read(runKey(selected))).toMatchObject({ status: "interrupted" })
      expect(await Storage.read(runKey(cold))).toMatchObject({ status: "running" })
      expect((await RolloutPending.tracked())?.owners).toContainEqual(selected)
    } finally {
      scan.mockRestore()
    }
  }))

test("corrupt uncommitted evidence blocks its owner without blocking startup or a new operation", () =>
  runtime.run(async () => {
    const broken = owner()
    await RolloutLedger.beginRun(broken, "run")
    const key = [...RolloutArtifact.root(broken), "journal", "events", "000000000001"]
    const original = await Storage.read(key)
    await Storage.write(key, { version: 99 })
    await Storage.write([...RolloutArtifact.root(broken), "journal", "head"], { allocated: 1, committed: 0 })
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    await RolloutRecovery.all()
    const fresh = owner()
    expect((await RolloutLedger.beginRun(fresh, "new")).status).toBe("running")
    await expect(RolloutLedger.beginRun(broken, "next")).rejects.toThrow()
    expect((await RolloutJournal.head(broken)).committed).toBe(0)
    await Storage.write(key, original)
    await Promise.all([RolloutSnapshot.read(broken), RolloutSnapshot.read(broken)])
    expect(await Storage.read(runKey(broken))).toMatchObject({ status: "interrupted" })
  }))

test("settled journal corruption remains visible to audit without blocking current records", () =>
  runtime.run(async () => {
    const retained = owner()
    await RolloutLedger.beginRun(retained, "run")
    await RolloutLedger.finishRun(retained, "run", "completed")
    const key = [...RolloutArtifact.root(retained), "journal", "events", "000000000001"]
    const original = await Storage.read(key)
    await Storage.write(key, { version: 99 })
    await RolloutRecovery.all()
    expect((await RolloutLedger.beginRun(retained, "next")).status).toBe("running")
    expect(await Storage.read(key)).toEqual({ version: 99 })
    expect((await RolloutSnapshot.presentation(retained)).verified).toBe(false)
    await expect(RolloutSnapshot.current(retained)).rejects.toThrow()
    await Storage.write(key, original)
    expect((await RolloutSnapshot.current(retained)).runs.map((run) => run.id).sort()).toEqual(["next", "run"])
  }))

test("shutdown retains untouched pending owners and clears only this runtime's writes", () =>
  runtime.run(async () => {
    const cold = owner()
    await RolloutLedger.beginRun(cold, "run")
    await RolloutRecovery.all()
    const current = owner()
    await RolloutLedger.beginRun(current, "run")
    await RolloutRecovery.settle()
    expect((await RolloutPending.tracked())?.owners).toEqual([cold])
    expect(await Storage.read(runKey(cold))).toMatchObject({ status: "running" })
    expect(await Storage.read(runKey(current))).toMatchObject({ status: "interrupted" })
  }))

// The pending ledger is global durable state within a test home; restore a
// clean slate after every test so sibling files in the same process are not
// poisoned by deliberately corrupted fixtures.
afterEach(() => runtime.run(() => Storage.remove(StoragePath.rolloutRecoveryPending())))
beforeEach(() =>
  runtime.run(async () => {
    await RolloutPending.markClean()
    await RolloutRecovery.all()
  }),
)

test("writes before first recovery preserve on-access discovery of historical owners", () =>
  runtime.run(async () => {
    const historical = owner()
    const migrated = owner()
    await RolloutLedger.beginSegment({ owner: historical, runID: "run", input: { task: "historical" } })
    await RolloutLedger.beginRun(migrated, "before")
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    await RolloutLedger.beginSegment({ owner: migrated, runID: "run", input: { task: "migration" } })
    expect(await RolloutPending.tracked()).toBeUndefined()
    await RolloutRecovery.all()
    expect((await RolloutSnapshot.read(historical)).segments[0].status).toBe("interrupted")
    expect((await RolloutSnapshot.read(migrated)).segments[0].status).toBe("interrupted")
    expect(await RolloutPending.tracked()).toMatchObject({ version: 2, owners: [] })
  }))

test("journal writes track their owner in the durable pending set before mutating", () =>
  runtime.run(async () => {
    const operationID = crypto.randomUUID()
    const target: RolloutSchema.Owner = { kind: "operation", scopeID: "test", operationID }
    await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
    expect((await RolloutPending.tracked())?.owners).toContainEqual(target)
    await RolloutLedger.beginSegment({ owner: target, runID: "run-2", input: { task: "more" } })
    const pending = await RolloutPending.tracked()
    expect(
      pending?.owners.filter((entry) => entry.kind === "operation" && entry.operationID === operationID),
    ).toHaveLength(1)
  }))

test("a clean pending set recovers nothing and checks no owners", () =>
  runtime.run(async () => {
    await RolloutPending.markClean()
    const seen: number[] = []
    await RolloutRecovery.all((current) => seen.push(current))
    expect(seen).toEqual([0])
    expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
  }))

test("a tracked owner recovers through the pending set and re-arms it", () =>
  runtime.run(async () => {
    const target = owner()
    await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("running")
    const seen: number[] = []
    await RolloutRecovery.all((current) => seen.push(current))
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
    expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
    expect(seen[0]).toBe(0)
    expect(seen).toEqual([0])
  }))

test("an untracked home records unknown coverage and recovers the selected owner", () =>
  runtime.run(async () => {
    const target = owner()
    await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    await RolloutRecovery.all()
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
    expect(await RolloutPending.tracked()).toMatchObject({ version: 2, owners: [] })
  }))

test("a malformed pending set preserves unknown coverage until owner access", () =>
  runtime.run(async () => {
    const target = owner()
    await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
    await Storage.write(StoragePath.rolloutRecoveryPending(), { version: 1, owners: [{ kind: "bogus" }] })
    await RolloutRecovery.all()
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
    expect(await RolloutPending.tracked()).toMatchObject({ version: 2, owners: [] })
  }))

test("settle settles listed owners and re-arms the ledger after a drained shutdown", () =>
  runtime.run(async () => {
    const target = owner()
    await RolloutLedger.beginSegment({ owner: target, runID: "run", input: { task: "original" } })
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("running")
    await RolloutRecovery.settle()
    expect((await RolloutSnapshot.read(target)).segments[0].status).toBe("interrupted")
    expect(await RolloutPending.tracked()).toEqual({ version: 1, owners: [] })
  }))

test("settle is a no-op without a trusted ledger", () =>
  runtime.run(async () => {
    await Storage.remove(StoragePath.rolloutRecoveryPending())
    await RolloutRecovery.settle()
    expect(await RolloutPending.tracked()).toBeUndefined()
  }))

test("settle leaves an untrusted ledger untouched", () =>
  runtime.run(async () => {
    await Storage.write(StoragePath.rolloutRecoveryPending(), { version: 1, owners: [{ kind: "bogus" }] })
    await RolloutRecovery.settle()
    expect(
      await Storage.read<{ version: 1; owners: Array<{ kind: string }> }>(StoragePath.rolloutRecoveryPending()),
    ).toEqual({
      version: 1,
      owners: [{ kind: "bogus" }],
    })
  }))

afterRuntimeTests(() => runtime.close())
test("maintenance settles the original touched rollout before freezing so shutdown needs no canonical write", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const tail = { kind: "operation" as const, scopeID: "maintenance", operationID: "native-tail" }
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments", "native-tail"] })
      RuntimeMaintenance.register("native-tail", {
        version: 1,
        order: 300,
        async suspend(context) {
          await RuntimeMaintenance.assertDraining(context.lease)
        },
        async drain(context) {
          await RuntimeMaintenance.assertDraining(context.lease)
          entered.resolve()
          await finish.promise
          await RolloutLedger.beginRun(tail, "tail")
          await RolloutLedger.finishRun(tail, "tail", "completed")
        },
        async inspect() {
          return []
        },
        async release(context) {
          await RuntimeMaintenance.assertReleasing(context.lease)
        },
      })
    },
  })
  await runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: "maintenance", operationID: "completed" }
    await RolloutLedger.beginRun(owner, "task")
    await RolloutLedger.finishRun(owner, "task", "completed")
    expect((await RolloutPending.tracked())?.owners).toContainEqual(owner)
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "settle-rollout",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Operator",
        clientKind: "system",
        requestID: "settle-rollout",
      },
    })
    try {
      const draining = RuntimeMaintenance.drain(lease)
      await entered.promise
      expect((await RolloutPending.tracked())?.owners).toContainEqual(owner)
      finish.resolve()
      const drained = await draining
      expect((await RolloutPending.tracked())?.owners).not.toContainEqual(owner)
      expect((await RolloutPending.tracked())?.owners).not.toContainEqual(tail)
      await RuntimeMaintenance.freeze(lease, drained)
      await RolloutRecovery.settle()
      expect((await RolloutLedger.getRun(owner, "task")).status).toBe("completed")
    } finally {
      finish.resolve()
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("failed native rollout settlement preserves its pending owner and refuses maintenance freeze", async () => {
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
    },
  })
  await runtime.run(async () => {
    const target = { kind: "operation" as const, scopeID: "maintenance", operationID: "failed-settlement" }
    await RolloutLedger.beginRun(target, "task")
    await RolloutLedger.finishRun(target, "task", "completed")
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "failed-rollout-settlement",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Operator",
        clientKind: "system",
        requestID: "failed-rollout-settlement",
      },
    })
    try {
      const reason = new Error("Original rollout settlement did not commit")
      const recovered = RolloutPending.recovered
      {
        using failed = spyOn(RolloutPending, "recovered").mockImplementation((identity) => {
          if (identity.kind === "operation" && identity.operationID === target.operationID) throw reason
          return recovered(identity)
        })
        await expect(RuntimeMaintenance.drain(lease)).rejects.toBe(reason)
        expect((await RuntimeMaintenance.operation(lease.maintenanceID))?.phase).toBe("draining")
        expect((await RolloutPending.tracked())?.owners).toContainEqual(target)
        expect((await RolloutLedger.getRun(target, "task")).status).toBe("completed")
      }
      const receipt = await RuntimeMaintenance.drain(lease)
      await RuntimeMaintenance.freeze(lease, receipt)
      expect((await RolloutPending.tracked())?.owners).not.toContainEqual(target)
    } finally {
      await RuntimeMaintenance.release(lease)
    }
  })
})

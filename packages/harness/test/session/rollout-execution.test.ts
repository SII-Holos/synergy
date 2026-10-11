import { afterAll, expect, spyOn, test } from "bun:test"
import { RolloutExecution } from "../../src/session/rollout/execution"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import type { RolloutSchema } from "../../src/session/rollout/schema"
import { testRuntime } from "../support/runtime"
import { RolloutExecutionMigration } from "../../src/session/rollout/execution-migration"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { fixture } from "../support/rollout"
import { migrations } from "../../src/session/migration"
import { migrateDeferredSession } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const owner = { kind: "operation" as const, scopeID: "test", operationID: "execution-timing" }

test("historical timing reads current run records without replaying the journal", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    const segment = await RolloutLedger.beginSegment({ owner: identity, runID: "old", input: {} })
    await RolloutLedger.finishSegment(segment, "completed")
    await historical(identity)
    const replay = spyOn(RolloutJournal, "events").mockImplementation(() => {
      throw new Error("timing reconstruction must not replay history")
    })
    try {
      await RolloutExecutionMigration.owner(identity)
      expect((await RolloutLedger.getRun(identity, "old")).timingVersion).toBe(1)
      expect(replay).not.toHaveBeenCalled()
    } finally {
      replay.mockRestore()
    }
  }))

async function historical(identity: RolloutSchema.Owner) {
  for (const run of (await RolloutSnapshot.read(identity)).runs)
    await RolloutJournal.write(identity, [...RolloutArtifact.root(identity), "runs", run.id, "info"], {
      ...run,
      timingVersion: undefined,
    })
}

test("new execution and cancellation records never enter historical timing reconstruction", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    const run = await RolloutLedger.beginRun(identity, "new")
    const cancelled = await RolloutLedger.cancelUnopenedRun(identity, "cancelled", Date.now())
    expect(run.timingVersion).toBe(1)
    expect(cancelled.timingVersion).toBe(1)
    const before = await RolloutSnapshot.read(identity)
    await RolloutExecutionMigration.owner(identity)
    expect(await RolloutSnapshot.read(identity)).toEqual(before)
  }))

function interval(started: number, ended?: number, clockID = "clock"): RolloutSchema.ExecutionInterval {
  return {
    version: 1,
    id: crypto.randomUUID(),
    owner,
    runID: "run",
    segmentID: crypto.randomUUID(),
    branchID: "main",
    clockID,
    started,
    ended,
    status: ended === undefined ? "active" : "closed",
    coverage: "complete",
  }
}

test("task time unions parallel branches, excludes gaps and sums separate runtime clocks", () => {
  expect(
    RolloutExecution.measure([interval(0, 10000), interval(0, 10000), interval(15000, 20000)], {
      clockID: "clock",
      now: 30000,
    }).elapsedMs,
  ).toBe(15000)
  expect(
    RolloutExecution.measure([interval(0, 10000), interval(0, 5000, "restart")], { clockID: "restart", now: 8000 })
      .elapsedMs,
  ).toBe(15000)
})

test("only current active intervals tick; missing crash tails are lower bounds", () => {
  expect(
    RolloutExecution.measure([interval(0, 10000), interval(20000)], { clockID: "clock", now: 23000 }),
  ).toMatchObject({ elapsedMs: 13000, elapsedActive: true, elapsedLowerBound: false })
  expect(RolloutExecution.measure([interval(0, 10000), interval(20000)], { clockID: "new", now: 90000 })).toMatchObject(
    { elapsedMs: 10000, elapsedActive: false, elapsedLowerBound: true },
  )
  expect(
    RolloutExecution.measure([{ ...interval(0, 0), coverage: "partial" }], { clockID: "clock", now: 90000 }),
  ).toMatchObject({ elapsedMs: 0, elapsedLowerBound: true })
})

test("human waits stop only their branch and cannot reopen a finished execution", () =>
  runtime.run(async () => {
    const segment = await RolloutLedger.beginSegment({ owner, runID: crypto.randomUUID(), input: {} })
    let release!: () => void
    let waiting!: () => void
    const entered = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = RolloutExecution.provide({ owner, runID: segment.runID }, async () => {
      await RolloutExecution.start(segment)
      await RolloutExecution.wait(async () => {
        waiting()
        await gate
      })
    })
    await entered
    const snapshot = await RolloutSnapshot.read(owner)
    expect(RolloutExecution.measure(snapshot.intervals).elapsedActive).toBe(false)
    expect(RolloutExecution.measure(snapshot.intervals).waiting).toBe(true)
    await RolloutExecution.stop(segment)
    release()
    await work
    expect(RolloutExecution.measure((await RolloutSnapshot.read(owner)).intervals)).toMatchObject({
      elapsedActive: false,
      waiting: false,
    })
  }))

test("recovery closes activity without counting the time when the runtime was absent", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    const segment = await RolloutLedger.beginSegment({ owner: identity, runID: "crash", input: {} })
    await RolloutExecution.provide({ owner: identity, runID: "crash" }, () => RolloutExecution.start(segment))
    await RolloutRecovery.owner(identity)
    const recovered = await RolloutSnapshot.read(identity)
    expect(recovered.intervals[0]).toMatchObject({ status: "interrupted", coverage: "partial" })
    expect(recovered.intervals[0].ended).toBeUndefined()
    expect(recovered.intervals[0].detectedAt).toBeNumber()
    expect(RolloutExecution.measure(recovered.intervals)).toMatchObject({
      elapsedMs: 0,
      elapsedActive: false,
      elapsedLowerBound: true,
    })
    await RolloutRecovery.owner(identity)
    expect(await RolloutSnapshot.read(identity)).toEqual(recovered)
  }))

test("historical correction preserves source evidence and is replayable and idempotent", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    await RolloutLedger.beginRun(identity, "queued")
    const segment = await RolloutLedger.beginSegment({ owner: identity, runID: "lost", input: {} })
    await RolloutLedger.finishSegment(segment, "interrupted")
    await RolloutLedger.finishRun(identity, "lost", "interrupted")
    await historical(identity)
    const before = await RolloutSnapshot.read(identity)
    await RolloutExecutionMigration.owner(identity)
    const after = await RolloutSnapshot.read(identity)
    expect(after.runs.find((run) => run.id === "queued")).toMatchObject({ status: "interrupted", admissionOnly: true })
    expect(RolloutExecution.measure(after.intervals)).toMatchObject({
      elapsedMs: 0,
      elapsedActive: false,
      elapsedLowerBound: true,
    })
    expect(await RolloutSnapshot.read(identity, { revision: before.revision })).toEqual(before)
    await RolloutExecutionMigration.owner(identity)
    expect(await RolloutSnapshot.read(identity)).toEqual(after)
    expect(await RolloutSnapshot.current(identity)).toEqual(after)
  }))

test("a waiting branch does not stop its parallel sibling", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    const segment = await RolloutLedger.beginSegment({ owner: identity, runID: "parallel", input: {} })
    const release = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const working = RolloutExecution.provide({ owner: identity, runID: segment.runID }, async () => {
      await RolloutExecution.start(segment)
      await RolloutExecution.suspend(() =>
        Promise.all([
          RolloutExecution.branch("human", () =>
            RolloutExecution.wait(async () => {
              ready.resolve()
              await release.promise
            }),
          ),
          RolloutExecution.branch("tool", () => release.promise),
        ]),
      )
      await RolloutExecution.stop(segment)
    })
    await ready.promise
    const snapshot = await RolloutSnapshot.read(identity)
    expect(RolloutExecution.measure(snapshot.intervals)).toMatchObject({ waiting: true, elapsedActive: true })
    release.resolve()
    await working
    expect(RolloutExecution.measure((await RolloutSnapshot.read(identity)).intervals)).toMatchObject({
      waiting: false,
      elapsedActive: false,
    })
  }))

test("wall clock corrections do not change execution duration", () => {
  const wall = spyOn(Date, "now")
  try {
    const evidence = [interval(1000, 6000), interval(8000)]
    for (const time of [0, 9e12, -9e12]) {
      wall.mockReturnValue(time)
      expect(RolloutExecution.measure(evidence, { clockID: "clock", now: 9000 }).elapsedMs).toBe(6000)
    }
  } finally {
    wall.mockRestore()
  }
})

test("one confirmed segment cannot conceal another segment with missing timing evidence", () =>
  runtime.run(async () => {
    const identity = { ...owner, operationID: crypto.randomUUID() }
    const first = await RolloutLedger.beginSegment({ owner: identity, runID: "partial", input: {} })
    await RolloutExecution.write({ ...interval(0, 1000), owner: identity, runID: first.runID, segmentID: first.id })
    await RolloutLedger.finishSegment(first, "interrupted")
    const second = await RolloutLedger.beginSegment({ owner: identity, runID: first.runID, input: {} })
    await RolloutLedger.finishSegment(second, "completed")
    const snapshot = await RolloutSnapshot.read(identity)
    expect(RolloutExecution.summarize({ ...snapshot, roots: snapshot.runs })).toMatchObject({
      elapsedMs: 1000,
      elapsedLowerBound: true,
      elapsedActive: false,
    })
  }))

test("historical migration backfills verified foreground transport and excludes auxiliary or recovery tails", () =>
  runtime.run(() =>
    fixture(async ({ call, rootID }) => {
      const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      for (const [usageRole, detectedAt, validWall] of [
        ["conversation", undefined, true],
        ["auxiliary", undefined, true],
        ["compaction", Date.now(), true],
        ["conversation", undefined, false],
      ] as const) {
        const next = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: rootID,
          model: call.model,
          purpose: usageRole,
          usageRole,
          request: {},
        })
        const recorder = RolloutTransportRecorder.create(next)
        const id = crypto.randomUUID()
        await recorder.emit({
          type: "attempt-start",
          attemptID: id,
          url: "https://fixture.test",
          method: "POST",
          mediaType: "application/json",
        })
        await recorder.emit({
          type: "attempt-end",
          attemptID: id,
          status: "completed",
          timing: {
            source: "transport",
            sentAt: segment.started,
            endedAt: segment.started + (validWall ? 100 : 90000),
            requestMs: 100,
            detectedAt,
            streaming: true,
            contentEvents: 2,
            reasoningObserved: false,
          },
        })
        await RolloutLedger.finishCall(call.owner, rootID, next.id, { status: "completed" })
      }
      await RolloutLedger.finishSegment(segment, "completed")
      await historical(call.owner)
      await RolloutExecutionMigration.owner(call.owner)
      const snapshot = await RolloutSnapshot.read(call.owner)
      expect(snapshot.intervals).toHaveLength(1)
      expect(RolloutExecution.measure(snapshot.intervals)).toMatchObject({
        elapsedMs: 100,
        elapsedActive: false,
        elapsedLowerBound: true,
      })
      expect(migrations).toContain(RolloutExecutionMigration.migration)
    }),
  ))

test("deferred imports receive the registered timing upgrade once and retain canonical completed results", () =>
  runtime.run(() =>
    fixture(async ({ session, call }) => {
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
      const cohort = ["compat_import", "cohorts", "session", RolloutExecutionMigration.migration.id]
      await RolloutLedger.beginRun(owner, "queued-input")
      await historical(owner)
      await Storage.write(cohort, {
        domain: "session",
        id: RolloutExecutionMigration.migration.id,
        residentComplete: true,
      })
      try {
        await migrateDeferredSession(owner, "canonical")
        const snapshot = await RolloutSnapshot.read(owner)
        expect(snapshot.runs.find((run) => run.id === "queued-input")).toMatchObject({
          admissionOnly: true,
          status: "interrupted",
        })
        expect(snapshot.runs.find((run) => run.id === call.runID)?.admissionOnly).not.toBe(true)
        expect(
          RolloutExecution.summarize({ roots: snapshot.runs, runs: snapshot.runs, intervals: snapshot.intervals }),
        ).toMatchObject({
          status: "completed",
          elapsedMs: 0,
          elapsedLowerBound: true,
          elapsedActive: false,
        })
        await migrateDeferredSession(owner, "canonical")
        expect(await RolloutSnapshot.read(owner)).toEqual(snapshot)
      } finally {
        await Storage.remove(cohort)
      }
    }),
  ))

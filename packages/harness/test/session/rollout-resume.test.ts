import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, spyOn, test } from "bun:test"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { Storage } from "../../src/storage/storage"

function invocation() {
  const id = crypto.randomUUID()
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: id },
    runID: id,
    purpose: "test",
    model: { providerID: "test", modelID: "model", sdk: "test", pricing: null },
    request: { messages: [{ role: "user", content: "hello" }] },
  }
}

/** A run left exactly as an aborted turn leaves it: cancellation requested, so
 *  `finishRun` records `cancelled` and every later write is refused. */
async function abortedRun() {
  const input = invocation()
  const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } })
  await RolloutLedger.requestCancel(input.owner, input.runID)
  await RolloutLedger.finishSegment(segment, "cancelled")
  await RolloutLedger.finishRun(input.owner, input.runID, "cancelled")
  return input
}

describe("RolloutLedger.resumeRun", () => {
  test("resumes a cancelled run so a user continue can append to it", () =>
    runtime.run(async () => {
      const input = await abortedRun()
      expect((await RolloutLedger.getRun(input.owner, input.runID)).status).toBe("cancelled")

      const resumed = await RolloutLedger.resumeRun(input.owner, input.runID)

      expect(resumed?.status).toBe("running")
      expect(resumed?.ended).toBeUndefined()
      // Clearing the cancellation is required, not cosmetic: `requireRunning`
      // treats `cancelRequestedAt` as a standing instruction to abort, so leaving
      // it set would let the resume succeed here and still refuse every write.
      expect(resumed?.cancelRequestedAt).toBeUndefined()
      // The whole point of Continue: a segment can actually be opened.
      const segment = await RolloutLedger.beginSegment({
        owner: input.owner,
        runID: input.runID,
        input: { task: "resumed" },
      })
      expect(segment.status).toBe("running")
    }))

  test("does not disturb a run that is already healthy", () =>
    runtime.run(async () => {
      const input = invocation()
      await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } })
      const before = await RolloutLedger.getRun(input.owner, input.runID)

      const resumed = await RolloutLedger.resumeRun(input.owner, input.runID)

      expect(resumed?.status).toBe("running")
      expect(resumed?.started).toBe(before.started)
      expect(resumed?.cancelRequestedAt).toBeUndefined()
    }))

  test("refuses a run whose recording failed", () =>
    runtime.run(async () => {
      const input = invocation()
      // The run has to exist before the failure marker can be persisted; a
      // marker written against a missing record only lives in memory. The
      // segment is settled first because `finishRun` refuses a run that still
      // has executing work.
      const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } })
      await RolloutLedger.finishSegment(segment, "failed")
      await RolloutLedger.failRecording(
        input.owner,
        input.runID,
        new RolloutRecordingError({ message: "recording failed" }),
      )
      await RolloutLedger.finishRun(input.owner, input.runID, "failed")

      const resumed = await RolloutLedger.resumeRun(input.owner, input.runID)

      // A user's intent to continue cannot repair unusable evidence, and the run
      // must not become appendable just because the request was explicit.
      expect(resumed?.recording).toBe("failed")
      await expect(
        RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } }),
      ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    }))

  test("refuses completed work", () =>
    runtime.run(async () => {
      const input = invocation()
      const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } })
      await RolloutLedger.finishSegment(segment, "completed")
      await RolloutLedger.finishRun(input.owner, input.runID, "completed")

      const resumed = await RolloutLedger.resumeRun(input.owner, input.runID)

      // Finished work is not a breakpoint, so there is nothing to resume from.
      expect(resumed?.status).toBe("completed")
    }))

  test("is idempotent and reports nothing for an unknown run", () =>
    runtime.run(async () => {
      const input = await abortedRun()
      await RolloutLedger.resumeRun(input.owner, input.runID)
      const second = await RolloutLedger.resumeRun(input.owner, input.runID)
      expect(second?.status).toBe("running")

      const unknown = invocation()
      expect(await RolloutLedger.resumeRun(unknown.owner, unknown.runID)).toBeUndefined()
    }))
})

afterRuntimeTests(() => runtime.close())

describe("RolloutLedger.continueRun", () => {
  test("admits another segment without rewriting completed evidence or replaying admission", () =>
    runtime.run(async () => {
      const input = invocation()
      const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: { task: "x" } })
      await RolloutLedger.finishSegment(segment, "completed")
      const before = await RolloutLedger.finishRun(input.owner, input.runID, "completed")
      const segments = await RolloutLedger.segments(input.owner, input.runID)
      await expect(RolloutLedger.beginCall(input)).rejects.toThrow("terminal rollout")
      let admissions = 0
      const admit = async () => {
        admissions++
      }
      const continued = await RolloutLedger.continueRun(input.owner, input.runID, admit)
      expect(continued).toMatchObject({
        status: "running",
        recording: "partial",
        started: before.started,
        input: before.input,
      })
      expect(continued?.ended).toBeUndefined()
      expect(continued?.execution).toBeUndefined()
      expect(await RolloutLedger.continueRun(input.owner, input.runID, admit)).toEqual(continued)
      expect(admissions).toBe(1)
      expect(await RolloutLedger.segments(input.owner, input.runID)).toEqual(segments)
      const next = await RolloutLedger.beginSegment({
        owner: input.owner,
        runID: input.runID,
        input: { task: "continuation" },
      })
      expect(next.status).toBe("running")
      expect(next.id).not.toBe(segment.id)
      expect((await RolloutLedger.getRun(input.owner, input.runID)).input).toEqual(before.input)
    }))

  for (const status of ["cancelled", "failed"] as const)
    test(`does not automatically reopen ${status} work`, () =>
      runtime.run(async () => {
        const input = invocation()
        const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: {} })
        if (status === "cancelled") await RolloutLedger.requestCancel(input.owner, input.runID)
        await RolloutLedger.finishSegment(segment, status)
        const before = await RolloutLedger.finishRun(input.owner, input.runID, status)
        expect(await RolloutLedger.continueRun(input.owner, input.runID)).toEqual(before)
        await expect(RolloutLedger.beginCall(input)).rejects.toThrow()
        expect(await RolloutLedger.getRun(input.owner, input.runID)).toEqual(before)
      }))

  for (const persisted of [true, false])
    test(`keeps admission closed after a ${persisted ? "persisted" : "memory-only"} recording failure`, () =>
      runtime.run(async () => {
        const input = invocation()
        const segment = await RolloutLedger.beginSegment({ owner: input.owner, runID: input.runID, input: {} })
        await RolloutLedger.finishSegment(segment, "completed")
        await RolloutLedger.finishRun(input.owner, input.runID, "completed")
        const failure = new RolloutRecordingError({ message: "Fixture recording failure" })
        if (persisted) await RolloutLedger.failRecording(input.owner, input.runID, failure)
        else {
          using write = spyOn(Storage, "write").mockRejectedValue(new Error("Fixture disk failure"))
          await RolloutLedger.failRecording(input.owner, input.runID, failure)
        }
        const before = await RolloutLedger.getRun(input.owner, input.runID)
        if (persisted) expect(await RolloutLedger.continueRun(input.owner, input.runID)).toEqual(before)
        else await expect(RolloutLedger.continueRun(input.owner, input.runID)).rejects.toBe(failure)
        await expect(RolloutLedger.beginCall(input)).rejects.toMatchObject({ name: "RolloutRecordingError" })
        expect(await RolloutLedger.getRun(input.owner, input.runID)).toEqual(before)
      }))
})

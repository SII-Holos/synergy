import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutRecordingError } from "../../src/session/rollout/error"

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

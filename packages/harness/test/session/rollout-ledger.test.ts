import { describe, expect, spyOn, test } from "bun:test"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSchema } from "../../src/session/rollout/schema"
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

describe("rollout invocation ledger", () => {
  test("keeps admission closed when the failure marker cannot be persisted", async () => {
    const input = invocation()
    await RolloutLedger.beginCall(input)
    {
      using write = spyOn(Storage, "write").mockRejectedValue(new Error("disk full"))
      await RolloutLedger.failRecording(
        input.owner,
        input.runID,
        new RolloutRecordingError({ message: "recording failed" }),
      )
    }
    expect((await RolloutLedger.getRun(input.owner, input.runID)).recording).toBe("partial")
    await expect(RolloutLedger.beginCall(input)).rejects.toMatchObject({ name: "RolloutRecordingError" })
    await expect(RolloutLedger.finishRun(input.owner, input.runID, "completed")).rejects.toMatchObject({
      name: "RolloutRecordingError",
    })
    const other = await RolloutLedger.beginCall(invocation())
    expect(other.status).toBe("running")
  })

  test("never upgrades failed recording to successful run completion", async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    await RolloutLedger.finishCall(input.owner, input.runID, call.id, { status: "failed" })
    await RolloutLedger.failRecording(
      input.owner,
      input.runID,
      new RolloutRecordingError({ message: "recording failed" }),
    )
    await expect(RolloutLedger.finishRun(input.owner, input.runID, "completed")).rejects.toMatchObject({
      name: "RolloutRecordingError",
    })
    expect((await RolloutLedger.finishRun(input.owner, input.runID, "failed")).recording).toBe("failed")
  })

  test("commits an attributable intent with explicit missing evidence", async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    const stored = await RolloutLedger.getCall(input.owner, input.runID, call.id)
    expect(stored).toEqual(call)
    expect(stored.status).toBe("running")
    expect(stored.sdkUsage).toBeNull()
    expect(stored.transportCaptured).toBe(false)
    expect(stored.request.status).toBe("complete")
    expect((await RolloutLedger.getRun(input.owner, input.runID)).status).toBe("running")
  })

  test("does not finish a run with pending calls", async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    await expect(RolloutLedger.finishRun(input.owner, input.runID, "completed")).rejects.toThrow("active calls")
    await RolloutLedger.finishCall(input.owner, input.runID, call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 7 },
    })
    const result = await RolloutLedger.finishRun(input.owner, input.runID, "completed")
    expect(result.status).toBe("completed")
    expect(result.recording).toBe("partial")
    await expect(RolloutLedger.beginCall(input)).rejects.toThrow("terminal")
  })

  test("retains failed calls and accepts parallel calls without lost records", async () => {
    const input = invocation()
    const calls = await Promise.all(Array.from({ length: 4 }, () => RolloutLedger.beginCall(input)))
    await Promise.all(
      calls.map((call) =>
        RolloutLedger.finishCall(input.owner, input.runID, call.id, { status: "failed", error: "provider failure" }),
      ),
    )
    const saved = await RolloutLedger.calls(input.owner, input.runID)
    expect(new Set(saved.map((call) => call.id)).size).toBe(4)
    expect(saved.every((call) => call.status === "failed")).toBe(true)
    expect(saved.every((call) => call.sdkUsage === null)).toBe(true)
  })

  test("keeps call completion immutable", async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    const first = await RolloutLedger.finishCall(input.owner, input.runID, call.id, { status: "cancelled" })
    const repeated = await RolloutLedger.finishCall(input.owner, input.runID, call.id, { status: "completed" })
    expect(repeated).toEqual(first)
    expect(RolloutSchema.CallRecord.parse(repeated).status).toBe("cancelled")
  })
})

test("a run preserves its input across execution segments and refuses completion during active work", async () => {
  const input = invocation()
  const first = await RolloutLedger.beginSegment({
    owner: input.owner,
    runID: input.runID,
    input: { task: "original" },
  })
  const run = await RolloutLedger.getRun(input.owner, input.runID)
  expect(run.input).toBeDefined()
  await expect(RolloutLedger.finishRun(input.owner, input.runID, "completed")).rejects.toThrow("active segments")
  await RolloutLedger.finishSegment(first, "completed")
  const second = await RolloutLedger.beginSegment({
    owner: input.owner,
    runID: input.runID,
    input: { task: "resumed" },
  })
  expect((await RolloutLedger.getRun(input.owner, input.runID)).input).toEqual(run.input)
  expect(second.id).not.toBe(first.id)
  await RolloutLedger.finishSegment(second, "completed")
  expect((await RolloutLedger.finishRun(input.owner, input.runID, "completed")).status).toBe("completed")
})

test("late tool completion cannot rewrite a cancelled or recovered execution", async () => {
  const input = invocation()
  const tool = await RolloutLedger.beginTool({
    ...input,
    messageID: "message",
    toolCallID: "toolcall",
    tool: "bash",
    args: {},
  })
  await RolloutLedger.writeTool({ ...tool, status: "interrupted", ended: Date.now() })
  await RolloutLedger.writeTool({ ...tool, status: "completed", ended: Date.now() + 1 })
  expect((await RolloutLedger.tools(input.owner, input.runID))[0].status).toBe("interrupted")
})

import { expect, spyOn, test } from "bun:test"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { Storage } from "../../src/storage/storage"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutPending } from "../../src/session/rollout/pending"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function invocation() {
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() },
    runID: "run",
    purpose: "test",
    model: { providerID: "test", modelID: "model", sdk: "@ai-sdk/openai", pricing: null },
    request: {},
  }
}

test("current call metadata does not admit historical execution owners", () =>
  runtime.run(async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    using admission = spyOn(RolloutJournal, "prepare").mockRejectedValue(new Error("historical admission blocked"))
    const current = await RolloutSnapshot.modelCalls(input.owner)
    expect(current.calls.map((value) => value.id)).toEqual([call.id])
    expect(admission).not.toHaveBeenCalled()
  }))

test("viewing retained calls preserves recovery obligations before the next execution", () =>
  runtime.run(async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    await RolloutRecovery.all()
    expect(await RolloutPending.needsRecovery(input.owner)).toBe(true)
    const retained = await RolloutSnapshot.modelCalls(input.owner)
    expect(retained.calls[0].status).toBe("running")
    expect(await RolloutPending.needsRecovery(input.owner)).toBe(true)
    await RolloutLedger.beginRun(input.owner, "next")
    expect((await RolloutSnapshot.modelCalls(input.owner)).calls.find((value) => value.id === call.id)?.status).toBe(
      "interrupted",
    )
  }))

test("presentation keeps unknown gaps explicit until a matching audit checkpoint is available", () =>
  runtime.run(async () => {
    const input = invocation()
    const root = RolloutArtifact.root(input.owner)
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await RolloutLedger.beginCall(input)
    const first = await RolloutSnapshot.presentation(input.owner)
    expect(first.verified).toBe(false)
    expect(first.snapshot.calls).toHaveLength(1)
    const verified = await RolloutSnapshot.current(input.owner)
    expect(verified.gaps).toEqual([1])
    using events = spyOn(RolloutJournal, "events")
    expect(await RolloutSnapshot.presentation(input.owner)).toEqual({ snapshot: verified, verified: true })
    expect(events).not.toHaveBeenCalled()
    await RolloutLedger.beginCall({ ...input, runID: "next" })
    const changed = await RolloutSnapshot.presentation(input.owner)
    expect(changed.verified).toBe(false)
    expect(changed.snapshot.calls).toHaveLength(2)
    expect((await RolloutSnapshot.current(input.owner)).gaps).toEqual([1])
  }))

test("snapshot freezes both metadata and the acknowledged response prefix", () =>
  runtime.run(async () => {
    const input = invocation()
    const call = await RolloutLedger.beginCall(input)
    const recorder = RolloutTransportRecorder.create(call)
    const attemptID = crypto.randomUUID()
    await recorder.emit({
      type: "attempt-start",
      attemptID,
      url: "https://provider.test/responses",
      method: "POST",
      mediaType: "application/json",
    })
    await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
    await recorder.emit({ type: "response", attemptID, status: 200, headers: {}, mediaType: "text/event-stream" })
    await recorder.emit({ type: "chunk", attemptID, channel: "response", data: new TextEncoder().encode("first") })
    const snapshot = await RolloutSnapshot.read(input.owner)
    await recorder.emit({ type: "chunk", attemptID, channel: "response", data: new TextEncoder().encode("last") })
    await recorder.finish()
    const same = await RolloutSnapshot.read(input.owner, { revision: snapshot.revision })
    expect(same).toEqual(snapshot)
    expect(same.attempts[0].status).toBe("running")
    const data = []
    for await (const chunk of RolloutArtifact.read(input.owner, same.attempts[0].response!)) data.push(chunk)
    expect(Buffer.concat(data).toString()).toBe("first")
    expect((await RolloutSnapshot.read(input.owner)).attempts[0].status).toBe("interrupted")
  }))

test("snapshot filters a run without mixing the owner's other runs", () =>
  runtime.run(async () => {
    const input = invocation()
    await RolloutLedger.beginCall(input)
    await RolloutLedger.beginCall({ ...input, runID: "other" })
    const snapshot = await RolloutSnapshot.read(input.owner, { runID: "run" })
    expect(snapshot.runs.map((run) => run.id)).toEqual(["run"])
    expect(snapshot.calls).toHaveLength(1)
    expect(snapshot.calls[0].runID).toBe("run")
  }))

afterRuntimeTests(() => runtime.close())

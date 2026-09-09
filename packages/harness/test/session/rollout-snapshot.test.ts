import { expect, test } from "bun:test"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { RolloutArtifact } from "../../src/session/rollout/artifact"

function invocation() {
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() },
    runID: "run",
    purpose: "test",
    model: { providerID: "test", modelID: "model", sdk: "@ai-sdk/openai", pricing: null },
    request: {},
  }
}

test("snapshot freezes both metadata and the acknowledged response prefix", async () => {
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
})

test("snapshot filters a run without mixing the owner's other runs", async () => {
  const input = invocation()
  await RolloutLedger.beginCall(input)
  await RolloutLedger.beginCall({ ...input, runID: "other" })
  const snapshot = await RolloutSnapshot.read(input.owner, { runID: "run" })
  expect(snapshot.runs.map((run) => run.id)).toEqual(["run"])
  expect(snapshot.calls).toHaveLength(1)
  expect(snapshot.calls[0].runID).toBe("run")
})

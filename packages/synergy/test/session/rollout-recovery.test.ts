import { expect, test } from "bun:test"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"

test("recovery preserves committed evidence, interrupts side effects, and resumes in a new segment", async () => {
  const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
  const segment = await RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "original" } })
  const call = await RolloutLedger.beginCall({
    owner,
    runID: "run",
    purpose: "test",
    request: {},
    model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
  })
  const writer = await RolloutArtifact.open(owner, "text/plain")
  await RolloutLedger.checkpointCall(owner, "run", call.id, writer.committed)
  await writer.append(new TextEncoder().encode("committed prefix"))
  await writer.checkpoint()
  await writer.append(new TextEncoder().encode("not committed"))
  await RolloutLedger.beginTool({
    owner,
    runID: "run",
    messageID: "message",
    toolCallID: "tool",
    tool: "bash",
    args: {},
  })
  await RolloutRecovery.owner(owner)
  const snapshot = await RolloutSnapshot.read(owner)
  expect(snapshot.segments[0].status).toBe("interrupted")
  expect(snapshot.calls[0].status).toBe("interrupted")
  expect(snapshot.tools[0].status).toBe("interrupted")
  const chunks: Uint8Array[] = []
  for await (const bytes of RolloutArtifact.read(owner, snapshot.calls[0].response!)) chunks.push(bytes)
  expect(Buffer.concat(chunks).toString()).toBe("committed prefix")
  expect(snapshot.runs[0].status).toBe("interrupted")
  await RolloutRecovery.owner(owner)
  expect(await RolloutSnapshot.read(owner)).toEqual(snapshot)
  const resumed = await RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "resumed" } })
  expect(resumed.id).not.toBe(segment.id)
  expect((await RolloutLedger.getRun(owner, "run")).input).toEqual(snapshot.runs[0].input)
  expect(await RolloutLedger.tools(owner, "run")).toHaveLength(1)
})

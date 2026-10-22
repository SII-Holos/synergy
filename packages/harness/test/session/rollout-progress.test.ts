import { afterAll, expect, test } from "bun:test"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture() {
  let now = 0
  const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
  const call = await RolloutLedger.beginCall({
    owner,
    runID: "run",
    purpose: "test",
    request: {},
    model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
  })
  const recorder = RolloutTransportRecorder.create(call, () => now)
  const attemptID = crypto.randomUUID()
  await recorder.emit({
    type: "attempt-start",
    attemptID,
    url: "https://fixture.test",
    method: "POST",
    mediaType: "application/json",
  })
  await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
  await recorder.emit({ type: "response", attemptID, status: 200, headers: {}, mediaType: "text/event-stream" })
  const initial = (await RolloutSnapshot.read(owner)).attempts[0]!
  return {
    owner,
    recorder,
    attemptID,
    initial,
    advance(ms: number) {
      now += ms
    },
    chunk(data: Uint8Array) {
      return recorder.emit({ type: "chunk", attemptID, channel: "response", data })
    },
    revision: async () => (await RolloutJournal.head(owner)).committed,
  }
}

test("each block is durable while progress is bounded by time and bytes", () =>
  runtime.run(async () => {
    const f = await fixture()
    const start = await f.revision()
    const block = new TextEncoder().encode("data: {}\n\n")
    for (let i = 0; i < 40; i++) await f.chunk(block)
    expect(await f.revision()).toBe(start + 1)
    const durable = await RolloutArtifact.get(f.owner, f.initial.response!.id)
    expect(durable.bytes).toBe(block.length * 40)
    const chunks = []
    for await (const chunk of RolloutArtifact.read(f.owner, durable)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat(Array.from({ length: 40 }, () => block)))
    f.advance(1000)
    await f.chunk(block)
    expect(await f.revision()).toBe(start + 2)
    for (let i = 0; i < 4; i++) await f.chunk(new Uint8Array(256 * 1024))
    expect(await f.revision()).toBe(start + 3)
    await f.recorder.finish()
  }))

test("recovery finds committed bytes newer than the progress journal", () =>
  runtime.run(async () => {
    const f = await fixture()
    const start = await f.revision()
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"retained"}}]}\n\n')
    await f.chunk(bytes)
    await f.chunk(bytes)
    expect(await f.revision()).toBe(start + 1)
    await RolloutRecovery.owner(f.owner)
    const attempt = (await RolloutSnapshot.read(f.owner)).attempts[0]!
    expect(attempt.status).toBe("interrupted")
    expect(attempt.response?.bytes).toBe(bytes.length * 2)
    const chunks = []
    for await (const chunk of RolloutArtifact.read(f.owner, attempt.response!)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([bytes, bytes]))
  }))

test.each(["completed", "cancelled", "failed"] as const)("%s flushes final usage and pending progress", (status) =>
  runtime.run(async () => {
    const f = await fixture()
    const start = await f.revision()
    await f.chunk(new TextEncoder().encode('data: {"choices":[]}\n\n'))
    await f.chunk(
      new TextEncoder().encode(
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":7,"total_tokens":17}}\n\n',
      ),
    )
    expect(await f.revision()).toBe(start + 2)
    await f.recorder.emit({
      type: "body-end",
      attemptID: f.attemptID,
      channel: "response",
      complete: status === "completed",
    })
    await f.recorder.emit({ type: "attempt-end", attemptID: f.attemptID, status })
    expect(await f.recorder.finish()).toBe(status === "completed")
    const attempt = (await RolloutSnapshot.read(f.owner)).attempts[0]!
    expect(attempt.status).toBe(status)
    expect(attempt.usageFinal).toBe(true)
    expect(attempt.usage?.input.total).toBe(10)
    expect(attempt.usage?.output.total).toBe(7)
    expect(attempt.response).toEqual(await RolloutArtifact.get(f.owner, f.initial.response!.id))
  }),
)

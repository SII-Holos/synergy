import { expect, test } from "bun:test"
import { RolloutAccounting } from "../../src/session/rollout/accounting"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { ProviderPricing } from "../../src/provider/pricing"

async function record(providerID = "openai") {
  const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
  const call = await RolloutLedger.beginCall({
    owner,
    runID: "run",
    purpose: "summary",
    request: {},
    model: {
      providerID,
      modelID: "test",
      sdk: "@ai-sdk/openai",
      pricing: ProviderPricing.resolve({
        providerID,
        modelID: "test",
        source: "configuration",
        cost: { input: 3, output: 15, cache_read: 1 },
      }),
    },
  })
  const recorder = RolloutTransportRecorder.create(call)
  async function attempt(usage: unknown) {
    const attemptID = crypto.randomUUID()
    await recorder.emit({
      type: "attempt-start",
      attemptID,
      url: "https://model.test/responses",
      method: "POST",
      mediaType: "application/json",
    })
    await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
    await recorder.emit({ type: "response", attemptID, status: 200, headers: {}, mediaType: "application/json" })
    await recorder.emit({
      type: "chunk",
      attemptID,
      channel: "response",
      data: new TextEncoder().encode(JSON.stringify({ usage })),
    })
    await recorder.emit({ type: "body-end", attemptID, channel: "response", complete: true })
    await recorder.emit({ type: "attempt-end", attemptID, status: "completed" })
  }
  return { owner, call, attempt }
}

const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 500,
  output_tokens_details: { reasoning_tokens: 100 },
}

test("accounts for each actual attempt once and treats reasoning as an output subset", async () => {
  const fixture = await record()
  await fixture.attempt(usage)
  const snapshot = await RolloutSnapshot.read(fixture.owner)
  const summary = RolloutAccounting.summarize(snapshot)
  expect(summary.attempts).toBe(1)
  expect(summary.tokens.total.known).toBe(1500)
  expect(summary.tokens.reasoning.known).toBe(100)
  expect(summary.apiEstimate.total).toBeCloseTo(0.0105)
  expect(summary.apiEstimate.unknown).toBe(0)
})

test("a retry without usage leaves total unknown while preserving the known subtotal", async () => {
  const fixture = await record()
  await fixture.attempt(null)
  await fixture.attempt(usage)
  const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
  expect(summary.attempts).toBe(2)
  expect(summary.apiEstimate).toMatchObject({ total: null, known: 0.0105, unknown: 1 })
  expect(summary.tokens.total).toEqual({ known: 1500, unknown: 1, total: null })
})

test("subscription API equivalents never increase API spending estimates", async () => {
  const fixture = await record("openai-codex")
  await fixture.attempt(usage)
  const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
  expect(summary.apiEstimate.known).toBe(0)
  expect(summary.subscriptionEquivalent.total).toBeCloseTo(0.0105)
})

test("calls without observable transport are explicit unknowns", async () => {
  const fixture = await record()
  const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
  expect(summary.unobservedCalls).toBe(1)
  expect(summary.apiEstimate.total).toBeNull()
  expect(summary.apiEstimate.unknown).toBe(1)
})

test("reported charges stay independent of token estimates, retries and aggregate currency", async () => {
  const fixture = await record("openrouter")
  await fixture.attempt({ ...usage, cost: 0.02, cost_details: { upstream_inference_cost: 0.5 } })
  await fixture.attempt(null)
  const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
  expect(summary.reported).toEqual({ currencies: { USD: 0.02 }, unreported: 1 })
  expect(summary.apiEstimate.known).toBe(0.0105)
  expect(RolloutAccounting.merge([summary, summary]).reported).toEqual({ currencies: { USD: 0.04 }, unreported: 2 })
})

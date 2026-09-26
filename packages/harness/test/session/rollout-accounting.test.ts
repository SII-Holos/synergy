import { expect, test } from "bun:test"
import { RolloutAccounting } from "../../src/session/rollout/accounting"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { ProviderPricing } from "../../src/provider/pricing"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function record(providerID = "openai", sdk = "@ai-sdk/openai") {
  const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
  const call = await RolloutLedger.beginCall({
    owner,
    runID: "run",
    purpose: "summary",
    request: {},
    model: {
      providerID,
      modelID: "test",
      sdk,
      pricing: ProviderPricing.resolve({
        providerID,
        modelID: "test",
        source: "configuration",
        cost: { input: 3, output: 15, cache_read: 1 },
      }),
    },
  })
  const recorder = RolloutTransportRecorder.create(call)
  async function attempt(usage: unknown, failedBeforeResponse = false) {
    const attemptID = crypto.randomUUID()
    await recorder.emit({
      type: "attempt-start",
      attemptID,
      url: "https://model.test/responses",
      method: "POST",
      mediaType: "application/json",
    })
    await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
    if (failedBeforeResponse) {
      await recorder.emit({ type: "attempt-end", attemptID, status: "failed" })
      return
    }
    await recorder.emit({
      type: "response",
      attemptID,
      status: 200,
      headers: {},
      mediaType: "application/json",
    })
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

test("accounts for each actual attempt once and treats reasoning as an output subset", () =>
  runtime.run(async () => {
    const fixture = await record()
    await fixture.attempt(usage)
    const snapshot = await RolloutSnapshot.read(fixture.owner)
    const summary = RolloutAccounting.summarize(snapshot)
    expect(summary.attempts).toBe(1)
    expect(summary.tokens.total.known).toBe(1500)
    expect(summary.tokens.reasoning.known).toBe(100)
    expect(summary.apiEstimate.total).toBeCloseTo(0.0105)
    expect(summary.apiEstimate.unknown).toBe(0)
  }))

test("a retry without usage leaves total unknown while preserving the known subtotal", () =>
  runtime.run(async () => {
    const fixture = await record()
    await fixture.attempt(null)
    await fixture.attempt(usage)
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.attempts).toBe(2)
    expect(summary.apiEstimate).toMatchObject({ total: null, known: 0.0105, unknown: 1 })
    expect(summary.tokens.total).toEqual({ known: 1500, unknown: 1, total: null })
  }))

test("subscription API equivalents never increase API spending estimates", () =>
  runtime.run(async () => {
    const fixture = await record("openai-codex")
    await fixture.attempt(usage)
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.apiEstimate.known).toBe(0)
    expect(summary.subscriptionEquivalent.total).toBeCloseTo(0.0105)
  }))

test("calls without observable transport are explicit unknowns", () =>
  runtime.run(async () => {
    const fixture = await record()
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.unobservedCalls).toBe(1)
    expect(summary.apiEstimate.total).toBeNull()
    expect(summary.apiEstimate.unknown).toBe(1)
  }))

test("reported charges stay independent of token estimates, retries and aggregate currency", () =>
  runtime.run(async () => {
    const fixture = await record("openrouter")
    await fixture.attempt({ ...usage, cost: 0.02, cost_details: { upstream_inference_cost: 0.5 } })
    await fixture.attempt(null)
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.reported).toEqual({ currencies: { USD: 0.02 }, unreported: 1 })
    expect(summary.apiEstimate.known).toBe(0.0105)
    expect(RolloutAccounting.merge([summary, summary]).reported).toEqual({
      currencies: { USD: 0.04 },
      unreported: 2,
    })
  }))

afterRuntimeTests(() => runtime.close())
test("usage recorded on the call survives a lost transport recording", () =>
  runtime.run(async () => {
    const fixture = await record()
    await RolloutLedger.finishCall(fixture.owner, "run", fixture.call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedInputTokens: 200 },
    })
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    // No attempt was ever recorded, so the call is still counted as unobserved…
    expect(summary.attempts).toBe(0)
    expect(summary.unobservedCalls).toBe(1)
    // …but its provider-reported usage is real, so tokens must not read as unknown.
    expect(summary.tokens.total.known).toBe(1500)
    expect(summary.tokens.total.unknown).toBe(0)
    expect(summary.tokens.input.known).toBe(1000)
    expect(summary.tokens.cacheRead.known).toBe(200)
  }))

test("a recorded attempt still wins over the call-level usage", () =>
  runtime.run(async () => {
    const fixture = await record()
    await fixture.attempt(usage)
    await RolloutLedger.finishCall(fixture.owner, "run", fixture.call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 999_999, outputTokens: 999_999, totalTokens: 1_999_998 },
    })
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.attempts).toBe(1)
    expect(summary.tokens.total.known).toBe(1500)
  }))

test("SDK usage cannot be charged again to a retry that failed before its response", () =>
  runtime.run(async () => {
    const fixture = await record()
    await fixture.attempt(null, true)
    await fixture.attempt(usage)
    await RolloutLedger.finishCall(fixture.owner, "run", fixture.call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
    })
    const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
    expect(summary.attempts).toBe(2)
    expect(summary.tokens.total).toEqual({ known: 1500, unknown: 1, total: null })
  }))

test.each(["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock"])(
  "SDK fallback preserves exclusive input and unknown cache writes for %s",
  (sdk) =>
    runtime.run(async () => {
      const fixture = await record("fixture", sdk)
      await RolloutLedger.finishCall(fixture.owner, "run", fixture.call.id, {
        status: "completed",
        sdkUsage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 900 },
      })
      const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
      expect(summary.tokens.uncached).toEqual({ known: 100, unknown: 0, total: 100 })
      expect(summary.tokens.cacheRead.known).toBe(900)
      expect(summary.tokens.cacheWrite.total).toBeNull()
      expect(summary.tokens.input).toEqual({ known: 1000, unknown: 1, total: null })
      expect(summary.tokens.total).toEqual({ known: 1050, unknown: 1, total: null })
    }),
)

test.each(["@ai-sdk/google", "@ai-sdk/google-vertex"])(
  "SDK fallback charges visible and thinking output for %s",
  (sdk) =>
    runtime.run(async () => {
      const fixture = await record("fixture", sdk)
      await RolloutLedger.finishCall(fixture.owner, "run", fixture.call.id, {
        status: "completed",
        sdkUsage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 80,
          totalTokens: 200,
          cachedInputTokens: 0,
        },
      })
      const summary = RolloutAccounting.summarize(await RolloutSnapshot.read(fixture.owner))
      expect(summary.tokens.output).toEqual({ known: 100, unknown: 0, total: 100 })
      expect(summary.tokens.total).toEqual({ known: 200, unknown: 0, total: 200 })
    }),
)

import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutSchema } from "../../src/session/rollout/schema"
import { RolloutUsage } from "../../src/session/rollout/usage"
import { ProviderPricing } from "../../src/provider/pricing"
import { UsageLedger } from "../../src/usage/ledger"
import { UsageMigration } from "../../src/usage/migration"
import { UsageQuery } from "../../src/usage/query"
import { runMigrations } from "../../src/migration"

const rawUsage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens: 500,
  output_tokens_details: { reasoning_tokens: 0 },
}
const body = `data: ${JSON.stringify({ type: "response.completed", response: { model: "fixture", usage: rawUsage } })}\r\n\r\n`
const recoveryID = "20261009-usage-response-recovery-v1"

async function fixture(
  options: {
    billingMode?: "api" | "subscription"
    pricing?: boolean
    knownUsage?: boolean
    attempts?: number
    body?: string
    status?: "completed" | "cancelled"
    owner?: RolloutSchema.Owner
  } = {},
) {
  const owner = options.owner ?? { kind: "operation", scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
  const pricing =
    options.pricing === false
      ? null
      : ProviderPricing.resolve({
          providerID: "openai",
          modelID: "fixture",
          source: "configuration",
          cost: { input: 3, output: 15, cache_read: 1 },
        })
  const billingMode = options.billingMode ?? "api"
  const call = await RolloutLedger.beginCall({
    owner,
    runID: crypto.randomUUID(),
    purpose: "fixture",
    request: {},
    model: { providerID: "openai", modelID: "fixture", sdk: "@ai-sdk/openai", pricing, billingMode },
  })
  const response = await RolloutArtifact.writeText(owner, options.body ?? body, "application/octet-stream")
  for (let index = 0; index < (options.attempts ?? 1); index++) {
    const attempt = RolloutSchema.AttemptRecord.parse({
      version: 1,
      id: crypto.randomUUID(),
      owner,
      runID: call.runID,
      callID: call.id,
      index,
      url: "https://fixture.invalid/responses",
      method: "POST",
      started: 1,
      ended: 2,
      status: options.status ?? "completed",
      request: call.request,
      response,
      usage: RolloutUsage.normalize("openai", options.knownUsage ? rawUsage : null),
      usageFinal: !!options.knownUsage,
      estimate: ProviderPricing.estimate(pricing, RolloutUsage.normalize("openai", null), billingMode, 2),
      pricingEvidence: { version: 1, source: "attempt", pricing },
    })
    await RolloutLedger.writeAttempt(attempt)
  }
  await RolloutLedger.finishCall(owner, call.runID, call.id, {
    status: "completed",
    transportCaptured: true,
    sdkUsage: { inputTokens: 99000, outputTokens: 99000 },
  })
  await RolloutLedger.finishRun(owner, call.runID, "completed")
  return { owner, call, response }
}

async function drain() {
  for (let index = 0; index < 100; index++) {
    const state = await UsageMigration.batch(8)
    if (state.status === "completed") return state
  }
  throw new Error("Usage recovery failed to finish bounded fixture")
}

test("manual rebuild repairs old checkpointed attempts and prices without rewriting execution evidence", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const value = await fixture({ attempts: 2 })
    const before = await RolloutLedger.attempts(value.owner, value.call.runID, value.call.id)
    expect((await UsageLedger.captureBatch(value.owner)).processed).toBe(0)
    expect((await UsageQuery.summary({ scopeID: value.owner.scopeID })).accounting.tokens.input.total).toBeNull()
    await UsageMigration.start()
    await drain()
    const first = await UsageQuery.summary({ scopeID: value.owner.scopeID })
    expect(first.accounting.tokens.input.total).toBe(2000)
    expect(first.accounting.tokens.output.total).toBe(1000)
    expect(first.accounting.tokens.cacheRead.total).toBe(400)
    expect(first.accounting.apiEstimate.total).toBeCloseTo(0.0202)
    expect(first.rates.generation.value).toBeNull()
    expect(await RolloutLedger.attempts(value.owner, value.call.runID, value.call.id)).toEqual(before)
    let archived = ""
    for await (const chunk of RolloutArtifact.read(value.owner, value.response))
      archived += new TextDecoder().decode(chunk)
    expect(archived).toBe(body)
    await UsageMigration.start()
    await drain()
    expect((await UsageQuery.summary({ scopeID: value.owner.scopeID })).accounting).toEqual(first.accounting)
    expect(await UsageLedger.revision()).toBe(first.revision)
    const head = await RolloutJournal.head(value.owner)
    for await (const event of RolloutJournal.events(value.owner, head.committed)) {
      if (event.kind === "record")
        await Storage.transaction(() => UsageLedger.capture(value.owner, event.seq, event.key, event.value, false))
    }
    expect((await UsageQuery.summary({ scopeID: value.owner.scopeID })).accounting).toEqual(first.accounting)
    expect(await UsageLedger.revision()).toBe(first.revision)
  })
}, 20_000)

test.each([false, true])(
  "recovery uses only saved pricing and retains subscription classification (pricing %s)",
  async (pricing) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const value = await fixture({ pricing, billingMode: "subscription", knownUsage: true })
      await UsageMigration.start()
      await drain()
      const summary = await UsageQuery.summary({ scopeID: value.owner.scopeID })
      expect(summary.accounting.tokens.input.total).toBe(1000)
      expect(summary.accounting.apiEstimate.known).toBe(0)
      expect(summary.accounting.subscriptionEquivalent.total).toBe(pricing ? 0.0101 : null)
    })
  },
  20_000,
)

test("recovery preserves explicit clears, pruned responses, damaged bodies and partial cancellations", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const cleared = await fixture()
    await UsageLedger.clear({ scopeID: cleared.owner.scopeID }, await UsageLedger.revision())
    const pruned = await fixture()
    await Storage.removeTree([...RolloutArtifact.root(pruned.owner), "artifacts", pruned.response.id])
    const damaged = await fixture({ body: "<html>upstream failed</html>" })
    const partial = await fixture({
      status: "cancelled",
      body: 'data: {"usage":{"input_tokens":1000}}\n\ndata: {"usage":',
    })
    await UsageMigration.start()
    await drain()
    expect((await UsageQuery.collect({ scopeID: cleared.owner.scopeID })).length).toBe(0)
    for (const value of [pruned, damaged]) {
      const summary = await UsageQuery.summary({ scopeID: value.owner.scopeID })
      expect(summary.accounting.tokens.input.total).toBeNull()
      expect(summary.accounting.apiEstimate.total).toBeNull()
    }
    const records = await UsageQuery.collect({ scopeID: partial.owner.scopeID, kind: "attempt" })
    expect(records[0]).toMatchObject({ usageFinal: false, usage: { input: { total: 1000 }, output: { total: null } } })
  })
}, 20_000)

test("versioned automatic recovery schedules completed old jobs and resumes after restart with concurrent capture", async () => {
  await using directory = await tmpdir()
  const home = path.join(directory.path, "home")
  await using first = await testRuntime({ home, register: UsageMigration.register })
  const value = await first.run(async () => {
    await runMigrations({ targetDomain: "usage", output: "silent" })
    expect((await UsageMigration.status())?.status).toBe("pending")
    const value = await fixture()
    const run = await RolloutLedger.getRun(value.owner, value.call.runID)
    for (let index = 0; index < 130; index++) {
      await RolloutJournal.write(value.owner, [...RolloutArtifact.root(value.owner), "runs", run.id, "info"], run)
    }
    await Storage.write(StoragePath.usageRebuild(), {
      version: 1,
      status: "completed",
      phase: "completed",
      owners: 1,
      records: 1,
      updatedAt: 1,
      failures: 0,
    })
    await Storage.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("usage"), (log) => {
      delete log[recoveryID]
    })
    await runMigrations({ targetDomain: "usage", output: "silent" })
    expect((await UsageMigration.status())?.status).toBe("pending")
    expect(
      (await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("usage")))[recoveryID],
    ).toBeGreaterThan(0)
    await UsageMigration.batch()
    await UsageMigration.batch()
    const progress = await UsageMigration.batch()
    expect(progress.status).toBe("running")
    expect(progress.records).toBe(128)
    await fixture({ owner: value.owner, knownUsage: true })
    return value
  })
  await first.close()
  await using restarted = await testRuntime({ home, register: UsageMigration.register })
  await restarted.run(async () => {
    expect((await UsageMigration.status())?.records).toBe(128)
    const state = await drain()
    expect(state.records).toBeLessThan(256)
    const summary = await UsageQuery.summary({ scopeID: value.owner.scopeID })
    expect(summary.accounting.tokens.input.total).toBe(2000)
    expect((await UsageLedger.captureBatch(value.owner)).processed).toBe(0)
    await UsageMigration.start()
    await drain()
    expect((await UsageQuery.summary({ scopeID: value.owner.scopeID })).accounting.apiEstimate.total).toBeCloseTo(
      0.0202,
    )
  })
}, 20_000)

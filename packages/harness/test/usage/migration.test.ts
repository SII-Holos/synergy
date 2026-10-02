import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { UsageMigration } from "../../src/usage/migration"
import { UsageQuery } from "../../src/usage/query"
import { UsageLedger } from "../../src/usage/ledger"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutSchema } from "../../src/session/rollout/schema"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { RolloutAccounting } from "../../src/session/rollout/accounting"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("historical capture resumes from durable pages without repricing or duplication", () =>
  runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
    const call = await RolloutLedger.beginCall({
      owner,
      runID: "historic",
      purpose: "title",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    await RolloutLedger.finishCall(owner, "historic", call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 40, outputTokens: 10 },
    })
    await Storage.removeTree(["usage"])
    await Storage.removeTree(["usage_owner"])
    await UsageMigration.start()
    let progress = await UsageMigration.batch(1)
    expect(progress.status).toBe("running")
    for (let i = 0; i < 100 && progress.status !== "completed"; i++) progress = await UsageMigration.batch(8)
    expect(progress.status).toBe("completed")
    const result = await UsageQuery.summary({ scopeID: owner.scopeID })
    expect(result.accounting.tokens.total.total).toBe(50)
    expect(result.accounting.apiEstimate.known).toBe(0)
    expect(result.rates.generation.value).toBeNull()
    await UsageMigration.start()
    while ((await UsageMigration.batch(100)).status !== "completed") {}
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting).toEqual(result.accounting)
  }))

test("historical raw response is captured before pruning and checkpoints resume by journal page", () =>
  runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
    const call = await RolloutLedger.beginCall({
      owner,
      runID: "raw",
      purpose: "title",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    const response = await RolloutArtifact.writeText(
      owner,
      JSON.stringify({ usage: { prompt_tokens: 70, completion_tokens: 10 } }),
      "application/json",
    )
    const attempt = RolloutSchema.AttemptRecord.parse({
      version: 1,
      id: crypto.randomUUID(),
      callID: call.id,
      runID: call.runID,
      owner,
      index: 0,
      started: 1,
      ended: 2,
      status: "completed",
      url: "https://fixture.test",
      method: "POST",
      request: call.request,
      response,
    })
    await RolloutJournal.write(
      owner,
      [...RolloutArtifact.root(owner), "runs", call.runID, "attempts", call.id, attempt.id],
      attempt,
    )
    await Storage.removeTree(StoragePath.usageOwner(owner.scopeID, UsageLedger.ownerKey(owner)))
    await Storage.remove(StoragePath.usageOwnerCheckpoint(owner.scopeID, UsageLedger.ownerKey(owner)))
    const first = await UsageLedger.captureBatch(owner, 1)
    expect(first.complete).toBe(false)
    expect(first.processed).toBe(1)
    await UsageLedger.captureOwner(owner)
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting.tokens.total.total).toBe(80)
    expect((await UsageLedger.captureBatch(owner, 1)).processed).toBe(0)
  }))

test("index rebuild invalidates an already cached empty summary", () =>
  runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
    const call = await RolloutLedger.beginCall({
      owner,
      runID: "index",
      purpose: "title",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    await RolloutLedger.finishCall(owner, call.runID, call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 1, outputTokens: 2 },
    })
    await Storage.removeTree(["usage_time", owner.scopeID])
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting.tokens.total.known).toBe(0)
    await UsageMigration.start()
    while ((await UsageMigration.batch(100)).status !== "completed") {}
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting.tokens.total.total).toBe(3)
  }))

test("pruned historical rollouts retain message accounting without reviving explicitly cleared calls", () =>
  runtime.run(async () => {
    const owner = { kind: "session" as const, scopeID: crypto.randomUUID(), sessionID: Identifier.ascending("session") }
    const rootID = Identifier.ascending("message")
    const summary = RolloutAccounting.empty()
    summary.tokens.input = { known: 40, total: 40, unknown: 0 }
    summary.tokens.output = { known: 10, total: 10, unknown: 0 }
    summary.tokens.total = { known: 50, total: 50, unknown: 0 }
    const message = {
      id: Identifier.ascending("message"),
      sessionID: owner.sessionID,
      role: "assistant",
      parentID: rootID,
      rootID,
      agent: "synergy",
      mode: "synergy",
      modelID: "test",
      providerID: "test",
      time: { created: 1, completed: 2 },
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 3,
      tokens: { input: 0, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      accounting: { kind: "rollout", callIDs: ["pruned_call"], summary },
    }
    await Storage.write(["sessions", owner.scopeID, owner.sessionID, "messages", message.id, "info"], message)
    await UsageMigration.preserve(owner)
    const retained = await UsageQuery.summary({ scopeID: owner.scopeID })
    expect(retained.accounting.tokens.total.total).toBe(50)
    expect(retained.accounting.legacy.cost).toBe(3)
    await UsageLedger.clear({ scopeID: owner.scopeID }, retained.revision)
    await UsageMigration.preserve(owner)
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting.tokens.total.known).toBe(0)

    const call = await RolloutLedger.beginCall({
      owner,
      runID: rootID,
      purpose: "synergy",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    await RolloutLedger.finishCall(owner, rootID, call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 40, outputTokens: 10 },
    })
    await RolloutLedger.finishRun(owner, rootID, "completed")
    const second = {
      ...message,
      id: Identifier.ascending("message"),
      accounting: { ...message.accounting, callIDs: [call.id] },
    }
    await Storage.write(["sessions", owner.scopeID, owner.sessionID, "messages", second.id, "info"], second)
    await UsageLedger.clear({ scopeID: owner.scopeID }, await UsageLedger.revision())
    await UsageMigration.preserve(owner)
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting.tokens.total.known).toBe(0)
  }))

import { afterAll, expect, spyOn, test } from "bun:test"
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

test("upgraded rebuilds retain their cursor without automatically enumerating history", () =>
  runtime.run(async () => {
    const saved = {
      version: 1 as const,
      status: "running" as const,
      phase: "sessions" as const,
      after: ["sessions", "old", "cursor", "info"],
      owners: 7,
      records: 23,
      failures: 0,
      updatedAt: 1,
    }
    await Storage.write(StoragePath.usageRebuild(), saved)
    using query = spyOn(Storage, "query")
    const stop = UsageMigration.service()
    await stop()
    expect(query).not.toHaveBeenCalled()
    expect(await UsageMigration.status()).toEqual(saved)
    expect(await UsageMigration.start()).toEqual({ ...saved, requested: true })
    await Storage.remove(StoragePath.usageRebuild())
  }))

test("on-demand usage repair touches only the selected owner and is idempotent", () =>
  runtime.run(async () => {
    const selected = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: "selected" }
    const cold = { ...selected, operationID: "cold", scopeID: crypto.randomUUID() }
    for (const owner of [selected, cold]) {
      const call = await RolloutLedger.beginCall({
        owner,
        runID: "run",
        purpose: "test",
        request: {},
        model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
      })
      await RolloutLedger.finishCall(owner, "run", call.id, {
        status: "completed",
        sdkUsage: { inputTokens: 2, outputTokens: 3 },
      })
      await Storage.removeTree(StoragePath.usageOwner(owner.scopeID, UsageLedger.ownerKey(owner)))
    }
    await UsageMigration.prepare(selected)
    expect((await UsageQuery.summary({ scopeID: selected.scopeID })).accounting.tokens.total.total).toBe(5)
    expect((await UsageQuery.summary({ scopeID: cold.scopeID })).accounting.tokens.total.total).toBe(0)
    const revision = await UsageLedger.revision()
    await UsageMigration.prepare(selected)
    expect(await UsageLedger.revision()).toBe(revision)
  }))

test("interleaved owner reads retain independent usage cursors and preserve the full rebuild cursor", () =>
  runtime.run(async () => {
    const owners = ["first", "second"].map((operationID) => ({
      kind: "operation" as const,
      scopeID: crypto.randomUUID(),
      operationID,
    }))
    for (const owner of owners)
      for (let index = 0; index < 70; index++) await RolloutLedger.beginRun(owner, String(index))
    const rebuild = { version: 1, owner: "full-rebuild", revision: 23, through: 90 }
    await Storage.write(StoragePath.usageReplay(), rebuild)
    using events = spyOn(RolloutJournal, "events")
    await UsageMigration.prepare(owners[0]!)
    await UsageMigration.prepare(owners[1]!)
    await UsageMigration.prepare(owners[0]!)
    await UsageMigration.prepare(owners[1]!)
    expect(events.mock.calls.map(([, , after]) => after)).toEqual([0, 0, 64, 64])
    expect(await Storage.read<typeof rebuild>(StoragePath.usageReplay())).toEqual(rebuild)
    events.mockClear()
    await UsageMigration.prepare(owners[0]!)
    expect(events).not.toHaveBeenCalled()
    await RolloutLedger.beginRun(owners[0]!, "later")
    await UsageMigration.prepare(owners[0]!)
    expect(events.mock.calls.map(([, , after]) => after)).toEqual([70])
  }))

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

test("lineage upgrade preserves orphaned historical descendants and is idempotent", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const parent = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    const owner = { kind: "operation" as const, scopeID, operationID: crypto.randomUUID() }
    const call = await RolloutLedger.beginCall({
      owner,
      runID: "child",
      purpose: "title",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    await RolloutLedger.finishCall(owner, "child", call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 40, outputTokens: 10 },
    })
    await UsageLedger.link(owner, "child", { owner: parent, runID: "removed-root", messageID: "message" })
    const link = await Storage.read<Parameters<typeof UsageLedger.parentKey>[0]>(
      StoragePath.usageLink(scopeID, UsageLedger.ownerKey(owner), "child"),
    )
    await Storage.remove(UsageLedger.parentKey(link)!)
    expect((await UsageQuery.collect({ scopeID, sessionID: parent.sessionID, includeDescendants: true })).length).toBe(
      0,
    )
    for (let n = 0; n < 2; n++) {
      await UsageMigration.lineageMigration.up(() => {})
      expect(
        (await UsageQuery.summary({ scopeID, sessionID: parent.sessionID, includeDescendants: true })).accounting.tokens
          .total.total,
      ).toBe(50)
    }
    await UsageLedger.link(owner, "child", {
      owner: { ...parent, sessionID: "other" },
      runID: "other",
      messageID: "message",
    })
    expect(await UsageQuery.collect({ scopeID, sessionID: parent.sessionID, includeDescendants: true })).toEqual([])
  }))

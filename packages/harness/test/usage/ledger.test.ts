import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { Storage } from "../../src/storage/storage"
import { UsageLedger } from "../../src/usage/ledger"
import { UsageQuery } from "../../src/usage/query"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("session usage does not read unrelated owners' counters, including an empty session", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    const foreign = ["usage", scopeID, "session_foreign", "run", "tool", "broken"]
    await Storage.write(foreign, { unavailable: true })
    await Storage.write(["usage_time", scopeID, "session_foreign", "00000000000000001_broken"], { key: foreign })
    expect((await UsageQuery.records({ scopeID, sessionID: owner.sessionID })).items).toEqual([])
    await invocation({ owner })
    expect((await UsageQuery.summary({ scopeID, sessionID: owner.sessionID })).accounting.tokens.total.total).toBe(1500)
    const first = await UsageQuery.records({ scopeID, sessionID: owner.sessionID }, { limit: 1 })
    const ids = first.items.map((item) => item.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await UsageQuery.records({ scopeID, sessionID: owner.sessionID }, { cursor, limit: 1 })
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(3)
    await Storage.removeTree(["usage_time", scopeID, "session_foreign"])
    await Storage.remove(foreign)
  }))

test("descendant selection never decodes unrelated lineage, even for an empty session", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    await Storage.write(["usage_link", scopeID, "session_foreign", "broken"], { invalid: true })
    expect((await UsageQuery.records({ scopeID, sessionID: owner.sessionID, includeDescendants: true })).items).toEqual(
      [],
    )
    await invocation({ owner })
    expect(
      (await UsageQuery.summary({ scopeID, sessionID: owner.sessionID, includeDescendants: true })).accounting.tokens
        .total.total,
    ).toBe(1500)
    await Storage.removeTree(["usage_link", scopeID, "session_foreign"])
  }))

test("selected usage collection includes every page without reading unrelated counters", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    await invocation({ owner })
    const template = (await UsageQuery.records({ scopeID, sessionID: owner.sessionID })).items[0]
    await Storage.transaction(async () => {
      for (let index = 0; index < 510; index++) {
        const value = { ...template, id: `extra-${index}`, entityID: `extra-${index}` }
        await Storage.write(UsageLedger.key(value), value)
        await UsageLedger.index(value)
      }
      const foreign = ["usage", scopeID, "session_foreign", "run", "tool", "broken"]
      await Storage.write(foreign, { unavailable: true })
      await Storage.write(["usage_time", scopeID, "session_foreign", "00000000000000001_broken"], { key: foreign })
    })
    const values = await UsageQuery.collect({ scopeID, sessionID: owner.sessionID })
    expect(values).toHaveLength(513)
    expect(new Set(values.map((value) => value.id)).size).toBe(513)
    expect(values.every((value) => value.owner.kind === "session" && value.owner.sessionID === owner.sessionID)).toBe(
      true,
    )
    await Storage.removeTree(["usage_time", scopeID, "session_foreign"])
    await Storage.removeTree(["usage", scopeID, "session_foreign"])
  }))

async function invocation(
  input: Partial<Pick<Parameters<typeof RolloutLedger.beginCall>[0], "owner" | "purpose" | "usageRole" | "runID">> = {},
) {
  const owner = input.owner ?? {
    kind: "operation" as const,
    scopeID: crypto.randomUUID(),
    operationID: crypto.randomUUID(),
  }
  const call = await RolloutLedger.beginCall({
    owner,
    runID: input.runID ?? "run",
    purpose: input.purpose ?? "summary",
    usageRole: input.usageRole,
    request: { private: "secret prompt" },
    model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null, billingMode: "api" },
  })
  const recorder = RolloutTransportRecorder.create(call)
  await RolloutTransport.provide(recorder.emit, async () => {
    await (
      await RolloutTransport.fetch(
        async () =>
          Response.json({
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              private: "secret response",
              prompt: "secret prompt",
            },
          }),
        "https://fixture.test",
      )
    ).text()
  })
  await recorder.finish()
  await RolloutLedger.finishCall(owner, input.runID ?? "run", call.id, {
    status: "completed",
    sdkUsage: { inputTokens: 1000, outputTokens: 500 },
  })
  await RolloutLedger.finishRun(owner, input.runID ?? "run", "completed")
  return { owner, call }
}

test("owner-scoped usage pages merge descendant sessions and operations in canonical order", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    const child = { ...owner, sessionID: crypto.randomUUID() }
    const operation = { kind: "operation" as const, scopeID, operationID: crypto.randomUUID() }
    for (const target of [owner, child, operation]) await invocation({ owner: target })
    await UsageLedger.link(child, "run", { owner, runID: "run", messageID: "root" })
    await UsageLedger.link(operation, "run", { owner: child, runID: "run", messageID: "child" })
    const expected = (await UsageQuery.records({ scopeID })).items.map((item) => item.id)
    const filter = { scopeID, sessionID: owner.sessionID }
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await UsageQuery.records(filter, { limit: 2, cursor })
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(ids).toEqual(expected)
    expect(ids).toHaveLength(9)
    expect((await UsageQuery.summary(filter)).accounting.tokens.total.total).toBe(4500)
    expect((await UsageQuery.records({ ...filter, includeDescendants: false })).items).toHaveLength(3)
  }))

test("canonical usage keeps independent input totals, unknown splits and compact records after evidence deletion", () =>
  runtime.run(async () => {
    const { owner } = await invocation()
    const before = await UsageQuery.summary({ scopeID: owner.scopeID })
    expect(before.accounting.tokens.total).toEqual({ known: 1500, unknown: 0, total: 1500 })
    expect(before.accounting.tokens.uncached.total).toBeNull()
    expect(before.cache.ratio).toBeNull()
    expect(before.accounting.attempts).toBe(1)
    await Storage.removeTree(RolloutArtifact.root(owner))
    expect((await UsageQuery.summary({ scopeID: owner.scopeID })).accounting).toEqual(before.accounting)
    const records = await UsageQuery.records({ scopeID: owner.scopeID })
    expect(records.items.some((item) => item.kind === "attempt")).toBe(true)
    expect(JSON.stringify(records)).not.toContain("secret")
    expect(JSON.stringify(records)).not.toContain("fixture.test")
  }))

test("conversation role survives transport capture and source deletion for custom agents", () =>
  runtime.run(async () => {
    const owner = { kind: "session" as const, scopeID: crypto.randomUUID(), sessionID: crypto.randomUUID() }
    await invocation({ owner, purpose: "custom-primary", usageRole: "conversation" })
    const scope = { scopeID: owner.scopeID, sessionID: owner.sessionID }
    const before = await UsageQuery.summary(scope)
    expect(before.context).toMatchObject({ inputTokens: 1000, modelID: "test" })
    const records = await UsageQuery.records(scope)
    const calls = records.items.filter((record) => record.kind === "call" || record.kind === "attempt")
    expect(calls.map((record) => record.usageRole)).toEqual(["conversation", "conversation"])
    await Storage.removeTree(RolloutArtifact.root(owner))
    expect((await UsageQuery.summary(scope)).context).toEqual(before.context)
  }))

test("clear is revision bounded, preserves active calls and suppresses replay resurrection", () =>
  runtime.run(async () => {
    const { owner } = await invocation()
    const active = await RolloutLedger.beginCall({
      owner,
      runID: "next",
      purpose: "summary",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    const captured = await UsageQuery.summary({ scopeID: owner.scopeID })
    const cleared = await UsageLedger.clear({ scopeID: owner.scopeID }, captured.revision)
    expect(cleared.removed).toBeGreaterThan(0)
    expect(cleared.activeRetained).toBeGreaterThan(0)
    await Storage.removeTree(["usage_owner"])
    await UsageLedger.captureOwner(owner)
    const after = await UsageQuery.records({ scopeID: owner.scopeID })
    expect(after.items.filter((item) => item.kind === "call").map((item) => item.entityID)).toEqual([active.id])
  }))

test("lineage survives clearing a parent while its child is active", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
    const child = { ...owner, sessionID: crypto.randomUUID() }
    await RolloutLedger.beginRun(owner, "root")
    await RolloutLedger.finishRun(owner, "root", "completed")
    await Storage.write(["sessions", scopeID, child.sessionID, "info"], { parentID: owner.sessionID })
    const call = await RolloutLedger.beginCall({
      owner: child,
      runID: "child",
      purpose: "explore",
      request: {},
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
    })
    const before = await UsageQuery.records({ scopeID, sessionID: owner.sessionID })
    expect(before.items.some((record) => record.entityID === call.id)).toBe(true)
    await UsageLedger.clear({ scopeID, sessionID: owner.sessionID }, before.revision)
    await Storage.removeTree(["sessions", scopeID])
    const after = await UsageQuery.records({ scopeID, sessionID: owner.sessionID })
    expect(after.items.some((record) => record.entityID === call.id)).toBe(true)
    expect(
      (await UsageQuery.records({ scopeID, sessionID: owner.sessionID, includeDescendants: false })).items,
    ).toHaveLength(0)
  }))

test("journal gaps are retained and prohibit claiming complete usage", () =>
  runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
    const root = RolloutArtifact.root(owner)
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await RolloutJournal.recover(owner)
    await Storage.removeTree(root)
    const result = await UsageQuery.summary({ scopeID: owner.scopeID })
    expect(result.accounting.journalGaps).toBe(1)
    expect(result.accounting.tokens.total.total).toBeNull()
  }))

async function ambiguousLineage() {
  const scopeID = crypto.randomUUID()
  const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
  const child = { ...owner, sessionID: crypto.randomUUID() }
  const ownerOnly = { ...owner, sessionID: crypto.randomUUID() }
  const unknownRun = { ...owner, sessionID: crypto.randomUUID() }
  const grandchild = { ...owner, sessionID: crypto.randomUUID() }
  const unknownGrandchild = { ...owner, sessionID: crypto.randomUUID() }
  const runs = [owner, owner, child, child, ownerOnly, unknownRun, grandchild, unknownGrandchild].map((owner) => ({
    owner,
    runID: crypto.randomUUID(),
  }))
  await Storage.write(["sessions", scopeID, ownerOnly.sessionID, "info"], { parentID: owner.sessionID })
  await Storage.write(["sessions", scopeID, unknownGrandchild.sessionID, "info"], { parentID: child.sessionID })
  for (const run of runs) await invocation(run)
  await Storage.transaction(async () => {
    await UsageLedger.link(child, runs[2]!.runID, { owner, runID: runs[0]!.runID, messageID: "selected" })
    await UsageLedger.link(child, runs[3]!.runID, { owner, runID: runs[1]!.runID, messageID: "sibling" })
    await UsageLedger.link(unknownRun, runs[5]!.runID, { owner, runID: null, messageID: "unknown" })
    await UsageLedger.link(grandchild, runs[6]!.runID, { owner: child, runID: runs[2]!.runID, messageID: "child" })
  })
  const selected: string[] = [runs[0]!.runID, runs[2]!.runID, runs[6]!.runID]
  return { scopeID, owner, runs, selected }
}

test("run selection requires exact ancestry while session selection retains owner-only descendants", () =>
  runtime.run(async () => {
    const { scopeID, owner, runs, selected } = await ambiguousLineage()
    for (const filter of [
      { runID: selected[0] },
      { scopeID, runID: selected[0] },
      { scopeID, sessionID: owner.sessionID, runID: selected[0] },
    ]) {
      const result = await UsageQuery.records(filter)
      expect(new Set(result.items.map((record) => record.runID))).toEqual(new Set(selected))
      expect((await UsageQuery.summary(filter)).accounting.tokens.total.total).toBe(4500)
    }
    const own = await UsageQuery.records({ scopeID, runID: selected[0], includeDescendants: false })
    expect(new Set(own.items.map((record) => record.runID))).toEqual(new Set([selected[0]]))
    const session = await UsageQuery.records({ scopeID, sessionID: owner.sessionID })
    expect(new Set(session.items.map((record) => record.runID))).toEqual(new Set(runs.map((run) => run.runID)))
  }))

test("run-scoped clearing preserves sibling runs and descendants without exact ancestry", () =>
  runtime.run(async () => {
    const { scopeID, runs, selected } = await ambiguousLineage()
    const before = await UsageQuery.records({ scopeID })
    const retained = before.items.filter((record) => !selected.includes(record.runID))
    const result = await UsageLedger.clear({ scopeID, runID: selected[0] }, before.revision)
    expect(result.removed).toBe(before.items.length - retained.length)
    const after = await UsageQuery.records({ scopeID })
    expect(new Set(after.items.map((record) => record.id))).toEqual(new Set(retained.map((record) => record.id)))
    expect((await UsageQuery.summary({ scopeID })).accounting.tokens.total.total).toBe(
      (runs.length - selected.length) * 1500,
    )
  }))

async function gapOwners() {
  const scopeID = crypto.randomUUID()
  const owner = { kind: "session" as const, scopeID, sessionID: crypto.randomUUID() }
  const child = { ...owner, sessionID: crypto.randomUUID() }
  const unrelated = { kind: "operation" as const, scopeID, operationID: crypto.randomUUID() }
  const runID = crypto.randomUUID()
  const childRunID = crypto.randomUUID()
  for (const [current, run] of [
    [owner, runID],
    [child, childRunID],
    [unrelated, crypto.randomUUID()],
  ] as const) {
    await RolloutLedger.beginRun(current, run)
    await RolloutLedger.finishRun(current, run, "completed")
  }
  await Storage.transaction(async () => {
    await UsageLedger.link(child, childRunID, { owner, runID, messageID: "parent-message" })
    for (const current of [owner, child, unrelated]) await UsageLedger.captureGap(current, 1, Date.now())
  })
  return { scopeID, owner, child, unrelated, runID }
}

test("run queries retain only their owners' gaps and include descendant gaps when selected", () =>
  runtime.run(async () => {
    const { scopeID, owner, child, runID } = await gapOwners()
    for (const scope of [{ runID }, { scopeID, runID }, { scopeID, sessionID: owner.sessionID, runID }]) {
      for (const includeDescendants of [true, false]) {
        const result = await UsageQuery.records({ ...scope, includeDescendants, kind: "gap" })
        expect(result.items).toHaveLength(includeDescendants ? 2 : 1)
        expect(result.items.map((record) => record.owner)).toEqual(
          expect.arrayContaining(includeDescendants ? [owner, child] : [owner]),
        )
        const summary = await UsageQuery.summary({ ...scope, includeDescendants })
        expect(summary.accounting.journalGaps).toBe(includeDescendants ? 2 : 1)
        expect(summary.own.journalGaps).toBe(1)
        expect(summary.descendants.journalGaps).toBe(includeDescendants ? 1 : 0)
        expect(summary.accounting.tokens.total.total).toBeNull()
      }
    }
    expect((await UsageQuery.summary({ scopeID, sessionID: owner.sessionID })).accounting.journalGaps).toBe(2)
    for (const missing of [crypto.randomUUID(), "unattributed"])
      expect((await UsageQuery.records({ scopeID, runID: missing, kind: "gap" })).items).toHaveLength(0)
  }))

test("run clears preserve unattributed owner gaps and unrelated execution evidence", () =>
  runtime.run(async () => {
    const { scopeID, owner, runID } = await gapOwners()
    const before = await UsageQuery.records({ scopeID })
    const cleared = await UsageLedger.clear({ scopeID, runID }, before.revision)
    expect(cleared.removed).toBe(2)
    expect(cleared.unattributedRetained).toBe(2)
    expect((await UsageQuery.records({ scopeID, kind: "gap" })).items).toHaveLength(3)
    expect((await UsageQuery.summary({ scopeID, runID })).accounting.journalGaps).toBe(2)
    expect((await UsageQuery.summary({ scopeID, runID })).own.journalGaps).toBe(1)
    const session = await UsageLedger.clear({ scopeID, sessionID: owner.sessionID }, await UsageLedger.revision())
    expect(session.unattributedRetained).toBe(0)
    expect((await UsageQuery.records({ scopeID, kind: "gap" })).items).toHaveLength(1)
  }))

test("time indexes are half-open and source transaction rollback leaves no usage", () =>
  runtime.run(async () => {
    const { owner } = await invocation()
    const all = await UsageQuery.records({ scopeID: owner.scopeID, kind: "attempt" })
    const attempt = all.items[0]
    if (attempt.kind !== "attempt") throw new Error("fixture")
    const sent = attempt.timing!.sentAt!
    expect(
      (await UsageQuery.records({ scopeID: owner.scopeID, kind: "attempt", from: sent, to: sent + 1 })).items,
    ).toHaveLength(1)
    expect((await UsageQuery.records({ scopeID: owner.scopeID, kind: "attempt", to: sent })).items).toHaveLength(0)
    const isolated = { ...owner, scopeID: crypto.randomUUID() }
    await expect(
      Storage.transaction(async () => {
        await UsageLedger.captureGap(isolated, 1, 100)
        throw new Error("abort fixture")
      }),
    ).rejects.toThrow("abort fixture")
    expect(await Storage.scan(["usage", isolated.scopeID])).toHaveLength(0)
    expect(await Storage.scan(["usage_time", isolated.scopeID])).toHaveLength(0)
  }))

test("home transfer preserves identities and clear suppression while advancing the query revision", () =>
  runtime.run(async () => {
    const { owner } = await invocation()
    const before = await UsageQuery.records({ scopeID: owner.scopeID })
    const attempt = before.items.find((record) => record.kind === "attempt")!
    await UsageLedger.clear({ scopeID: owner.scopeID }, before.revision)
    await Storage.write(UsageLedger.key(attempt), { ...attempt, revision: before.revision + 100 })
    await Storage.transaction((tx) => UsageLedger.reconcileTransfer(tx))
    const after = await UsageQuery.records({ scopeID: owner.scopeID })
    expect(after.items).toHaveLength(0)
    expect(after.revision).toBeGreaterThan(before.revision + 100)
  }))

test("historical and current primary identities share reporting without rewriting billing records", () =>
  runtime.run(async () => {
    const { owner: legacy } = await invocation({ purpose: "synergy-max", usageRole: "conversation" })
    const { owner: current } = await invocation({ purpose: "forge", usageRole: "conversation" })
    const before = await Storage.readMany(await Storage.list(["usage", legacy.scopeID]))
    expect((await UsageQuery.summary({ scopeID: legacy.scopeID, agent: "forge" })).accounting.attempts).toBe(1)
    expect((await UsageQuery.summary({ scopeID: current.scopeID, agent: "synergy-max" })).accounting.attempts).toBe(1)
    const summary = await UsageQuery.summary({ agent: "forge" })
    expect(summary.agents.forge?.attempts).toBe(2)
    expect(summary.agents["synergy-max"]).toBeUndefined()
    expect(await Storage.readMany(await Storage.list(["usage", legacy.scopeID]))).toEqual(before)
  }))

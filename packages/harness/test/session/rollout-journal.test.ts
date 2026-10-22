import { expect, spyOn, test } from "bun:test"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { Storage } from "../../src/storage/storage"
import { RolloutSchema } from "../../src/session/rollout/schema"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture } from "../migration/fixture"
const runtime = await migrationFixture()

function run(owner: ReturnType<typeof targetOwner>, status: "running" | "completed" | "failed") {
  return { version: 1, id: "run", owner, started: 1, status, recording: "partial" }
}

function targetOwner() {
  return { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
}

test("attempt history shares immutable context and decodes mixed formats without changing projections", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = RolloutArtifact.root(target)
    const id = crypto.randomUUID()
    const key = [...root, "runs", "run", "attempts", "call", id]
    const attempt: RolloutSchema.AttemptRecord = {
      version: 1,
      id,
      owner: target,
      runID: "run",
      callID: "call",
      index: 0,
      url: "https://fixture.invalid/" + "path".repeat(500),
      method: "POST",
      started: 1,
      status: "running",
      request: {
        version: 1,
        id: crypto.randomUUID(),
        mediaType: "application/json",
        bytes: 0,
        chunks: 0,
        sha256: null,
        status: "partial",
      },
      pricingEvidence: { version: 1, source: "attempt", pricing: null },
    }
    await Storage.write([...root, "runs", "run", "calls", "call"], {
      version: 1,
      id: "call",
      owner: target,
      runID: "run",
      purpose: "fixture",
      model: { providerID: "fixture", modelID: "fixture", sdk: "fixture", pricing: null },
      started: 1,
      status: "running",
      request: attempt.request,
      sdkUsage: null,
      transportCaptured: true,
    })
    await RolloutJournal.write(target, key, attempt)
    const updated = { ...attempt, httpStatus: 200, responseHeaders: { "x-request-id": "next" } }
    await RolloutJournal.write(target, key, updated)
    await RolloutLedger.writeAttempt({ ...updated, error: undefined })
    expect((await RolloutJournal.head(target)).committed).toBe(2)
    await RolloutJournal.write(target, key, { ...updated, status: "completed", ended: 2 })
    const stored = await Storage.read<{ version: number; context: string }>([
      ...root,
      "journal",
      "events",
      "000000000003",
    ])
    expect(stored.version).toBe(2)
    expect(JSON.stringify(stored)).not.toContain(attempt.url)
    expect(await Storage.scan([...root, "journal", "contexts"])).toHaveLength(2)
    const events = []
    for await (const event of RolloutJournal.events(target, 3)) events.push(event)
    expect(events.map((event) => event.kind === "record" && event.value)).toEqual([
      attempt,
      updated,
      { ...updated, status: "completed", ended: 2 },
    ])
    expect(await Storage.read(key)).toEqual({ ...updated, status: "completed", ended: 2 })
    await Storage.write([...root, "journal", "events", "000000000001"], events[0])
    const mixed = []
    for await (const event of RolloutJournal.events(target, 3)) mixed.push(event)
    expect(mixed).toEqual(events)
    await Storage.remove([...root, "journal", "contexts", stored.context])
    await expect(Array.fromAsync(RolloutJournal.events(target, 3))).rejects.toThrow("Missing rollout journal context")
  }))

test("journal snapshots keep a fixed revision while later records are written", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
    await RolloutJournal.write(target, key, run(target, "running"))
    const head = await RolloutJournal.head(target)
    await RolloutJournal.write(target, key, run(target, "completed"))
    const events = []
    for await (const event of RolloutJournal.events(target, head.committed)) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0].kind === "record" ? events[0].value : null).toEqual(run(target, "running"))
    expect((await RolloutJournal.head(target)).committed).toBe(2)
  }))

test("a failed commit rolls back its allocation, evidence and projection together", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    const original = Storage.write.bind(Storage)
    {
      using write = spyOn(Storage, "write").mockImplementation(async (path, value) => {
        if (path.join("/") === key.join("/")) throw new Error("projection unavailable")
        return original(path, value)
      })
      await expect(RolloutJournal.write(target, key, run(target, "running"))).rejects.toMatchObject({
        name: "RolloutRecordingError",
      })
    }
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
    await expect(Storage.read([...root, "journal", "events", "000000000001"])).rejects.toBeInstanceOf(
      Storage.NotFoundError,
    )
    expect(await RolloutJournal.write(target, key, run(target, "failed"))).toBe(1)
    const events = []
    for await (const event of RolloutJournal.events(target, 1)) events.push(event)
    expect(events.map((event) => (event.kind === "record" ? event.value : null))).toEqual([run(target, "failed")])
  }))

test("one logical write commits its evidence before acknowledging the usage outbox", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
    let commits = 0
    await ObservabilityMetrics.withForwarder(
      (metric) => {
        if (metric.name === "storage.transaction.count" && metric.labels?.outcome === "committed")
          commits += metric.value
      },
      async () => expect(await RolloutJournal.write(target, key, run(target, "running"))).toBe(1),
    )
    expect(commits).toBe(2)
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 1, committed: 1 })
  }))

test("recovery restores historical committed projections without replaying execution", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    // Durable state left by an interrupted two-phase write: the sequence was
    // allocated and its event recorded, but the projection never applied.
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await Storage.write([...root, "journal", "events", "000000000001"], {
      version: 1,
      kind: "record",
      seq: 1,
      time: Date.now(),
      key: ["runs", "run", "info"],
      value: run(target, "running"),
    })
    expect(await RolloutJournal.recover(target)).toEqual({ recovered: 1, gaps: [] })
    expect(await Storage.read<{ status: string }>(key)).toEqual(run(target, "running"))
    expect(await RolloutJournal.recover(target)).toEqual({ recovered: 0, gaps: [] })
  }))

test("an interrupted evidence transaction does not leave a newly allocated gap", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    const original = Storage.write.bind(Storage)
    {
      using write = spyOn(Storage, "write").mockImplementation(async (path, value) => {
        if (path.includes("events")) throw new Error("interrupted event")
        return original(path, value)
      })
      await expect(RolloutJournal.write(target, key, run(target, "running"))).rejects.toThrow()
    }
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
    await RolloutJournal.write(target, key, run(target, "failed"))
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 1, committed: 1 })
  }))

test("a historical missing reserved event remains an explicit gap", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = RolloutArtifact.root(target)
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], run(target, "failed"))
    const events = []
    for await (const event of RolloutJournal.events(target, 2)) events.push(event)
    expect(events[0]).toMatchObject({ seq: 1, kind: "gap" })
    expect(events[1]).toMatchObject({ seq: 2, kind: "record", value: run(target, "failed") })
  }))

test("large committed histories replay in bounded reads without changing their revision or order", () =>
  runtime.run(async () => {
    const target = targetOwner()
    const root = [...RolloutArtifact.root(target), "journal"]
    await Storage.transaction(async () => {
      await Storage.write([...root, "head"], { allocated: 260, committed: 260 })
      for (let seq = 1; seq <= 260; seq++) {
        await Storage.write([...root, "events", String(seq).padStart(12, "0")], {
          version: 1,
          seq,
          time: seq,
          kind: "gap",
        })
      }
    })
    using read = spyOn(Storage, "read")
    using readMany = spyOn(Storage, "readMany")
    const events = []
    for await (const event of RolloutJournal.events(target, 258, 2)) events.push(event)
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 256 }, (_, i) => i + 3))
    expect(read.mock.calls.length + readMany.mock.calls.length).toBeLessThan(10)
    expect(readMany.mock.calls.every(([keys]) => keys.length <= 128)).toBe(true)
  }))

test.each(["missing", "mismatched"])(
  "replay rejects a %s committed event after the first batch",
  runtime.bind(async (failure) => {
    const target = targetOwner()
    const root = [...RolloutArtifact.root(target), "journal"]
    await Storage.transaction(async () => {
      await Storage.write([...root, "head"], { allocated: 130, committed: 130 })
      for (let seq = 1; seq <= 130; seq++) {
        if (seq === 130 && failure === "missing") continue
        await Storage.write([...root, "events", String(seq).padStart(12, "0")], {
          version: 1,
          seq: seq === 130 ? 131 : seq,
          time: seq,
          kind: "gap",
        })
      }
    })
    const seen: number[] = []
    const replay = async () => {
      for await (const event of RolloutJournal.events(target, 130)) seen.push(event.seq)
    }
    if (failure === "missing") await expect(replay()).rejects.toBeInstanceOf(Storage.NotFoundError)
    else await expect(replay()).rejects.toThrow("Rollout journal sequence mismatch")
    expect(seen).toHaveLength(129)
  }),
)

afterRuntimeTests(() => runtime.close())

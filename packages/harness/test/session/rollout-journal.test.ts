import { expect, spyOn, test } from "bun:test"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { SqlConnection } from "../../src/storage/sql-contract"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture } from "../migration/fixture"
const runtime = await migrationFixture()

function owner() {
  return { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
}

test("journal snapshots keep a fixed revision while later records are written", () =>
  runtime.run(async () => {
    const target = owner()
    const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
    await RolloutJournal.write(target, key, { status: "running" })
    const head = await RolloutJournal.head(target)
    await RolloutJournal.write(target, key, { status: "completed" })
    const events = []
    for await (const event of RolloutJournal.events(target, head.committed)) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0].kind === "record" ? events[0].value : null).toEqual({ status: "running" })
    expect((await RolloutJournal.head(target)).committed).toBe(2)
  }))

test("a failed commit rolls back its allocation, evidence and projection together", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    const original = Storage.write.bind(Storage)
    {
      using write = spyOn(Storage, "write").mockImplementation(async (path, value) => {
        if (path.join("/") === key.join("/")) throw new Error("projection unavailable")
        return original(path, value)
      })
      await expect(RolloutJournal.write(target, key, { status: "running" })).rejects.toMatchObject({
        name: "RolloutRecordingError",
      })
    }
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
    await expect(Storage.read([...root, "journal", "events", "000000000001"])).rejects.toBeInstanceOf(
      Storage.NotFoundError,
    )
    expect(await RolloutJournal.write(target, key, { status: "failed" })).toBe(1)
    const events = []
    for await (const event of RolloutJournal.events(target, 1)) events.push(event)
    expect(events.map((event) => (event.kind === "record" ? event.value : null))).toEqual([{ status: "failed" }])
  }))

test("one logical write commits once and leaves its head fully committed", () =>
  runtime.run(async () => {
    const target = owner()
    const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
    const original = SqliteDriver.prototype.transaction
    let commits = 0
    {
      using counted = spyOn(SqliteDriver.prototype, "transaction").mockImplementation(async function <T>(
        this: SqliteDriver,
        body: (connection: SqlConnection) => Promise<T>,
        options?: { readOnly?: boolean; operationID?: string },
      ) {
        if (!options?.readOnly) commits++
        return (await original.call(this, body, options)) as T
      })
      expect(await RolloutJournal.write(target, key, { status: "running" })).toBe(1)
    }
    expect(commits).toBe(1)
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 1, committed: 1 })
  }))

test("recovery restores historical committed projections without replaying execution", () =>
  runtime.run(async () => {
    const target = owner()
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
      value: { status: "running" },
    })
    expect(await RolloutJournal.recover(target)).toEqual({ recovered: 1, gaps: [] })
    expect(await Storage.read<{ status: string }>(key)).toEqual({ status: "running" })
    expect(await RolloutJournal.recover(target)).toEqual({ recovered: 0, gaps: [] })
  }))

test("an interrupted evidence transaction does not leave a newly allocated gap", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    const original = Storage.write.bind(Storage)
    {
      using write = spyOn(Storage, "write").mockImplementation(async (path, value) => {
        if (path.includes("events")) throw new Error("interrupted event")
        return original(path, value)
      })
      await expect(RolloutJournal.write(target, key, { status: "running" })).rejects.toThrow()
    }
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
    await RolloutJournal.write(target, key, { status: "failed" })
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 1, committed: 1 })
  }))

test("a historical missing reserved event remains an explicit gap", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], { status: "failed" })
    const events = []
    for await (const event of RolloutJournal.events(target, 2)) events.push(event)
    expect(events[0]).toMatchObject({ seq: 1, kind: "gap" })
    expect(events[1]).toMatchObject({ seq: 2, kind: "record", value: { status: "failed" } })
  }))

test("large committed histories replay in bounded reads without changing their revision or order", () =>
  runtime.run(async () => {
    const target = owner()
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
    const target = owner()
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

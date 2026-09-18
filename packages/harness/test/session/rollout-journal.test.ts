import { expect, spyOn, test } from "bun:test"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { SqlConnection } from "../../src/storage/sql-contract"
import { Storage } from "../../src/storage/storage"

function owner() {
  return { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
}

test("journal snapshots keep a fixed revision while later records are written", async () => {
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
})

test("a failed commit rolls back its allocation, evidence and projection together", async () => {
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
})

test("one logical write commits once and leaves its head fully committed", async () => {
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
})

test("recovery restores historical committed projections without replaying execution", async () => {
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
})

test("an interrupted evidence transaction does not leave a newly allocated gap", async () => {
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
})

test("a historical missing reserved event remains an explicit gap", async () => {
  const target = owner()
  const root = RolloutArtifact.root(target)
  await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
  await RolloutJournal.write(target, [...root, "runs", "run", "info"], { status: "failed" })
  const events = []
  for await (const event of RolloutJournal.events(target, 2)) events.push(event)
  expect(events[0]).toMatchObject({ seq: 1, kind: "gap" })
  expect(events[1]).toMatchObject({ seq: 2, kind: "record", value: { status: "failed" } })
})

import { expect, spyOn, test } from "bun:test"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
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

test("a failed commit never reuses an allocated sequence or overwrites its evidence", async () => {
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
  expect((await RolloutJournal.head(target)).committed).toBe(0)
  await RolloutJournal.write(target, key, { status: "failed" })
  const events = []
  for await (const event of RolloutJournal.events(target, 2)) events.push(event)
  expect(events.map((event) => (event.kind === "record" ? event.value : null))).toEqual([
    { status: "running" },
    { status: "failed" },
  ])
})

test("recovery restores committed projections without replaying execution", async () => {
  const target = owner()
  const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
  const original = Storage.write.bind(Storage)
  {
    using write = spyOn(Storage, "write").mockImplementation(async (path, value) => {
      if (path.join("/") === key.join("/")) throw new Error("interrupted projection")
      return original(path, value)
    })
    await expect(RolloutJournal.write(target, key, { status: "running" })).rejects.toThrow()
  }
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

// One event more than the reader's internal window, so the range spans two read batches.
const SEEDED_EVENTS = 513

async function seedEvents(target: ReturnType<typeof owner>, count: number) {
  const journal = [...RolloutArtifact.root(target), "journal"]
  await Storage.transaction(async () => {
    for (let seq = 1; seq <= count; seq++) {
      const event =
        seq === count
          ? {
              version: 1,
              kind: "record" as const,
              seq,
              time: Date.now(),
              key: ["runs", "run", "info"],
              value: { status: "completed" },
            }
          : { version: 1, kind: "gap" as const, seq, time: Date.now() }
      await Storage.write([...journal, "events", String(seq).padStart(12, "0")], event)
    }
    await Storage.write([...journal, "head"], { allocated: count, committed: count })
  })
}

async function collectEvents(target: ReturnType<typeof owner>, through: number, after = 0) {
  const events: RolloutJournal.Event[] = []
  for await (const event of RolloutJournal.events(target, through, after)) events.push(event)
  return events
}

test("reads a journal range across read batches and keeps every event in sequence", async () => {
  const target = owner()
  await seedEvents(target, SEEDED_EVENTS)
  const events = await collectEvents(target, SEEDED_EVENTS)
  expect(events).toHaveLength(SEEDED_EVENTS)
  expect(events.map((event) => event.seq)).toEqual(Array.from({ length: SEEDED_EVENTS }, (_, index) => index + 1))
  expect(events[SEEDED_EVENTS - 2]).toMatchObject({ seq: SEEDED_EVENTS - 1, kind: "gap" })
  expect(events[SEEDED_EVENTS - 1]).toMatchObject({
    seq: SEEDED_EVENTS,
    kind: "record",
    value: { status: "completed" },
  })
})

test("bounds a batched journal range by the requested boundary", async () => {
  const target = owner()
  await seedEvents(target, SEEDED_EVENTS)
  expect((await collectEvents(target, SEEDED_EVENTS, SEEDED_EVENTS - 1)).map((event) => event.seq)).toEqual([
    SEEDED_EVENTS,
  ])
  expect(await collectEvents(target, 0, 0)).toEqual([])
  await expect(collectEvents(target, 0, 1)).rejects.toThrow("Invalid rollout journal boundary")
})

test("a missing committed event inside a batch stays a typed miss", async () => {
  const target = owner()
  const journal = [...RolloutArtifact.root(target), "journal"]
  await Storage.transaction(async () => {
    await Storage.write([...journal, "events", String(1).padStart(12, "0")], {
      version: 1,
      kind: "gap",
      seq: 1,
      time: Date.now(),
    })
    await Storage.write([...journal, "head"], { allocated: 2, committed: 2 })
  })
  await expect(collectEvents(target, 2)).rejects.toMatchObject({ name: "NotFoundError" })
})

test("a mismatched journal sequence inside a batch stays fatal", async () => {
  const target = owner()
  const journal = [...RolloutArtifact.root(target), "journal"]
  await Storage.transaction(async () => {
    await Storage.write([...journal, "events", String(1).padStart(12, "0")], {
      version: 1,
      kind: "gap",
      seq: 2,
      time: Date.now(),
    })
    await Storage.write([...journal, "head"], { allocated: 1, committed: 1 })
  })
  await expect(collectEvents(target, 1)).rejects.toThrow("Rollout journal sequence mismatch")
})

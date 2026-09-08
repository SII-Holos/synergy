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
    using write = spyOn(Storage, "write").mockImplementation(async (path, value, options) => {
      if (path.join("/") === key.join("/")) throw new Error("projection unavailable")
      return original(path, value, options)
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
    using write = spyOn(Storage, "write").mockImplementation(async (path, value, options) => {
      if (path.join("/") === key.join("/")) throw new Error("interrupted projection")
      return original(path, value, options)
    })
    await expect(RolloutJournal.write(target, key, { status: "running" })).rejects.toThrow()
  }
  expect(await RolloutJournal.recover(target)).toEqual({ recovered: 1, gaps: [] })
  expect(await Storage.read<{ status: string }>(key)).toEqual({ status: "running" })
  expect(await RolloutJournal.recover(target)).toEqual({ recovered: 0, gaps: [] })
})

test("a missing reserved event remains an explicit gap at later read boundaries", async () => {
  const target = owner()
  const root = RolloutArtifact.root(target)
  const key = [...root, "runs", "run", "info"]
  const original = Storage.write.bind(Storage)
  {
    using write = spyOn(Storage, "write").mockImplementation(async (path, value, options) => {
      if (path.includes("events")) throw new Error("interrupted event")
      return original(path, value, options)
    })
    await expect(RolloutJournal.write(target, key, { status: "running" })).rejects.toThrow()
  }
  await RolloutJournal.write(target, key, { status: "failed" })
  const events = []
  for await (const event of RolloutJournal.events(target, 2)) events.push(event)
  expect(events[0]).toMatchObject({ seq: 1, kind: "gap" })
  expect(events[1]).toMatchObject({ seq: 2, kind: "record", value: { status: "failed" } })
})

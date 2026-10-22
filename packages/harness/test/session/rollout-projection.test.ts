import fs from "node:fs/promises"
import path from "node:path"
import { afterAll, expect, spyOn, test } from "bun:test"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { storageQueuePriority } from "../../src/storage/queue"
import { Storage } from "../../src/storage/storage"
import { migrationFixture } from "../migration/fixture"
import { contextDraft } from "../support/context-usage"

const runtime = await migrationFixture()
afterAll(() => runtime.close())
const owner = () => ({ kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() })
const value = (target: ReturnType<typeof owner>, status: "running" | "completed") => ({
  version: 1,
  id: "run",
  owner: target,
  started: 1,
  status,
  recording: "partial",
})

test("current projection persists validated history and reads only subsequently committed events", () =>
  runtime.run(async () => {
    const target = owner()
    const key = [...RolloutArtifact.root(target), "runs", "run", "info"]
    await RolloutJournal.write(target, key, value(target, "running"))
    expect(await RolloutSnapshot.current(target)).toEqual(await RolloutSnapshot.read(target))
    using events = spyOn(RolloutJournal, "events")
    expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("running")
    expect(events).not.toHaveBeenCalled()
    await RolloutJournal.write(target, key, value(target, "completed"))
    const current = await RolloutSnapshot.current(target)
    expect(events).toHaveBeenCalledWith(target, 2, 1)
    expect(current).toEqual(await RolloutSnapshot.read(target))
    expect((await RolloutSnapshot.read(target, { revision: 1 })).runs[0].status).toBe("running")
  }))

test("cached presentation never weakens strict audit and rejects a missing tail event", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], value(target, "running"))
    await RolloutSnapshot.current(target)
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], value(target, "completed"))
    await Storage.remove([...root, "journal", "events", "000000000002"])
    await expect(RolloutSnapshot.current(target)).rejects.toThrow("Missing committed")
    await expect(RolloutSnapshot.read(target)).rejects.toThrow("Missing committed")
  }))

test("owner deletion and recreation cannot reuse a previous projection", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], value(target, "completed"))
    await RolloutSnapshot.current(target)
    await Storage.removeTree(root)
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], value(target, "running"))
    expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("running")
  }))

test("presentation checkpoint survives closing and reopening the storage runtime", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "rollout-checkpoint-"))
  try {
    const target = owner()
    {
      await using first = await migrationFixture({ home })
      await first.run(async () => {
        await RolloutJournal.write(
          target,
          [...RolloutArtifact.root(target), "runs", "run", "info"],
          value(target, "completed"),
        )
        await RolloutSnapshot.current(target)
      })
    }
    await using second = await migrationFixture({ home })
    await second.run(async () => {
      using events = spyOn(RolloutJournal, "events")
      expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("completed")
      expect(events).not.toHaveBeenCalled()
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("append during projection publishes the validated prefix and the next read replays only its tail", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    await RolloutJournal.write(target, key, value(target, "running"))
    const original = RolloutJournal.events
    const replayed: number[] = []
    {
      using events = spyOn(RolloutJournal, "events").mockImplementation(async function* (...args) {
        replayed.push(args[2] ?? 0)
        for await (const event of original(...args)) {
          await RolloutJournal.write(target, key, value(target, "completed"))
          yield event
        }
      })
      for (let revision = 1; revision <= 3; revision++) {
        expect((await RolloutSnapshot.current(target)).revision).toBe(revision)
        expect(await Storage.read([...root, "snapshot-v1"])).toMatchObject({ snapshot: { revision } })
      }
    }
    expect(replayed).toEqual([0, 1, 2])
    using events = spyOn(RolloutJournal, "events")
    expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("completed")
    expect(events).toHaveBeenCalledWith(target, 4, 3)
  }))

test("model-call presentation reads current run and call headers without replaying journal or tool evidence", () =>
  runtime.run(async () => {
    const target = owner()
    const call = await RolloutLedger.beginCall({
      owner: target,
      runID: "run",
      purpose: "general",
      usageRole: "conversation",
      model: { providerID: "test", modelID: "test", sdk: "@ai-sdk/openai", pricing: null },
      request: {},
    })
    const root = RolloutArtifact.root(target)
    for (let index = 0; index < 128; index++) {
      const id = `other-${index}`
      await RolloutJournal.write(target, [...root, "runs", id, "info"], { ...value(target, "completed"), id })
    }
    await Storage.write([...root, "runs", "run", "tools", "unrelated"], { invalid: true })
    using events = spyOn(RolloutJournal, "events")
    const snapshot = await RolloutSnapshot.modelCalls(target)
    expect(snapshot.runs).toHaveLength(129)
    expect(snapshot.calls.map((entry) => entry.id)).toEqual([call.id])
    expect(events).not.toHaveBeenCalled()
    await RolloutLedger.updateContextEstimate(target, call.runID, call.id, {
      ...contextDraft(),
      version: 1,
      capturedAt: Date.now(),
    })
    expect((await RolloutSnapshot.modelCalls(target)).calls[0].contextEstimate).toMatchObject({ version: 1 })
    expect(events).not.toHaveBeenCalled()
  }))

test("a slower projection cannot replace a newer checkpoint", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    await RolloutJournal.write(target, key, value(target, "running"))
    const original = RolloutJournal.events
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    using events = spyOn(RolloutJournal, "events").mockImplementation(async function* (...args) {
      for await (const event of original(...args)) {
        if (args[1] === 1) {
          reached.resolve()
          await release.promise
        }
        yield event
      }
    })
    const older = RolloutSnapshot.current(target)
    try {
      await reached.promise
      await RolloutJournal.write(target, key, value(target, "completed"))
      expect((await RolloutSnapshot.current(target)).revision).toBe(2)
    } finally {
      release.resolve()
      await older
    }
    expect(await Storage.read([...root, "snapshot-v1"])).toMatchObject({ snapshot: { revision: 2 } })
  }))

test("owner recreation during projection cannot publish the deleted owner's prefix", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    await RolloutJournal.write(target, key, value(target, "completed"))
    const original = RolloutJournal.events
    {
      using events = spyOn(RolloutJournal, "events").mockImplementation(async function* (...args) {
        for await (const event of original(...args)) {
          await Storage.removeTree(root)
          await RolloutJournal.write(target, key, value(target, "running"))
          yield event
        }
      })
      expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("completed")
    }
    await expect(Storage.read([...root, "snapshot-v1"])).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect((await RolloutSnapshot.current(target)).runs[0].status).toBe("running")
  }))

test("unsupported checkpoint format is rebuilt while historical gaps remain visible", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    await Storage.write([...root, "journal", "head"], { allocated: 1, committed: 0 })
    await RolloutJournal.write(target, [...root, "runs", "run", "info"], value(target, "completed"))
    await Storage.write([...root, "snapshot-v1"], { version: 999 })
    expect((await RolloutSnapshot.current(target)).gaps).toEqual([1])
    expect(await RolloutSnapshot.current(target)).toEqual(await RolloutSnapshot.read(target))
  }))

test("checkpoint reconstruction yields storage priority to interactive reads", () =>
  runtime.run(async () => {
    const target = owner()
    await RolloutJournal.write(
      target,
      [...RolloutArtifact.root(target), "runs", "run", "info"],
      value(target, "completed"),
    )
    const original = RolloutJournal.events
    const priorities: string[] = []
    using events = spyOn(RolloutJournal, "events").mockImplementation(async function* (...args) {
      priorities.push(storageQueuePriority())
      yield* original(...args)
    })
    const result = await RolloutSnapshot.currentAll([target, owner()])
    expect(result.map((item) => item.revision)).toEqual([1, 0])
    expect(priorities).toEqual(["background"])
    expect(storageQueuePriority()).toBe("foreground")
  }))

test("cancelled presentation stops replay and leaves no partial checkpoint", () =>
  runtime.run(async () => {
    const target = owner()
    const root = RolloutArtifact.root(target)
    const key = [...root, "runs", "run", "info"]
    await RolloutJournal.write(target, key, value(target, "running"))
    await RolloutJournal.write(target, key, value(target, "completed"))
    const abort = new AbortController()
    const original = RolloutJournal.events
    let read = 0
    {
      using events = spyOn(RolloutJournal, "events").mockImplementation(async function* (...args) {
        for await (const event of original(...args)) {
          read++
          abort.abort()
          yield event
        }
      })
      await expect(RolloutSnapshot.current(target, abort.signal)).rejects.toMatchObject({ name: "AbortError" })
    }
    expect(read).toBe(1)
    await expect(Storage.read([...root, "snapshot-v1"])).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await RolloutSnapshot.current(target)).toEqual(await RolloutSnapshot.read(target))
  }))

import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationSharedHistory } from "../src/shared-history"
import { OrganizationSharedProjection as Projection } from "../src/shared-projection"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationSharedGeneration as Generations } from "../src/shared-generation"
import { sharedProducerFixture } from "./support/shared-producer"

type Rows = Map<string, unknown>
function source(rows: Rows) {
  const accepted = new Set<string>()
  const groups = new Map<string, string>()
  const reader: OrganizationSharedHistory.Source = {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing original historical row")
      return schema.parse(structuredClone(value))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const parsed = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value: structuredClone(value) }
      }
    },
    accept(key) {
      accepted.add(JSON.stringify(key))
    },
    first(key, value) {
      const id = JSON.stringify(key),
        hash = digest(JSON.stringify(value)),
        previous = groups.get(id)
      if (previous !== undefined && previous !== hash) throw new Error("Changed original historical group")
      if (previous !== undefined) return false
      groups.set(id, hash)
      return true
    },
    async binary() {
      throw new Error("The metadata fixture has no original native binary checkpoint")
    },
  }
  return { reader, accepted }
}

test("actual synchronized transcript history rejects gaps and corrupt derivatives despite a completed preparation", async () => {
  await using f = await sharedProducerFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "historical-transcript",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  const session = await f.run(() => Directory.get(f.credentials.alice, "historical-transcript"))
  await f.run(() => Sharing.share(f.credentials.alice, session.sessionID, { expectedShareGeneration: 0 }))
  const events: Sync.Event[] = [
    {
      type: "session",
      sequence: 1,
      session: {
        sessionID: session.sessionID,
        projectID: session.projectID,
        creatorID: session.creatorID,
        driverRuntimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
        createdAt: session.createdAt + 1000,
        shareGeneration: 1,
      },
    },
    {
      type: "message",
      sequence: 2,
      messageID: "history-message",
      role: "assistant",
      createdAt: 1,
      summary: "",
      integrity: "a".repeat(64),
    },
    {
      type: "part",
      sequence: 3,
      messageID: "history-message",
      partID: "history-part",
      part: { type: "text", content: { kind: "inline", text: "earlier" } },
      integrity: "b".repeat(64),
    },
    {
      type: "part",
      sequence: 4,
      messageID: "history-message",
      partID: "history-part",
      part: { type: "text", content: { kind: "inline", text: "ACKed complete version" } },
      integrity: "c".repeat(64),
    },
  ]
  const payloadHash = digest(JSON.stringify({ firstSeq: 1, lastSeq: 4, events }))
  await f.run(() =>
    f.sync({
      schemaVersion: 1,
      sessionID: session.sessionID,
      projectID: session.projectID,
      bindingEpoch: session.bindingEpoch,
      shareGeneration: 1,
      firstSeq: 1,
      lastSeq: 4,
      payloadHash,
      events,
    }),
  )
  expect((await f.run(() => Sharing.snapshot(f.credentials.bob, session.sessionID, { limit: 100 }))).watermark).toBe(4)
  const rows = await f.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const valid = source(rows)
  await Sharing.history(valid.reader)
  expect(valid.accepted.has(JSON.stringify(Keys.sharedState(session.sessionID)))).toBe(true)
  expect(valid.accepted.has(JSON.stringify(Keys.sharedEvent(session.sessionID, 1, 4)))).toBe(true)
  const storedRoot = valid.reader.read(Record.SharedEvent, Keys.sharedEvent(session.sessionID, 1, 1))
  if (storedRoot.event.type !== "session") throw new Error("The real producer lost its root projection")
  expect(storedRoot.event.session.createdAt).toBe(session.createdAt)
  expect(valid.reader.read(Record.SharedBatch, Keys.sharedBatch(session.sessionID, 1, 1)).payloadHash).toBe(payloadHash)

  const current = [...rows].find(([key, value]) => {
    const parsed = JSON.parse(key)
    return (
      parsed[1] === "transcript" && parsed[4] === "current-v2" && Record.SharedEvent.parse(value).event.type === "part"
    )
  })
  if (!current) throw new Error("The original producer did not write its actual current part index")
  const stale = new Map(rows)
  stale.set(current[0], rows.get(JSON.stringify(Keys.sharedEvent(session.sessionID, 1, 3))))
  await expect(Sharing.history(source(stale).reader)).rejects.toThrow("indexes differ")

  const gap = new Map(rows)
  gap.delete(JSON.stringify(Keys.sharedEvent(session.sessionID, 1, 3)))
  await expect(Sharing.history(source(gap).reader)).rejects.toThrow("canonical event sequence")

  const unknown = new Map(rows)
  unknown.set(JSON.stringify([...Projection.generationPrefix(session.sessionID, 1), "unowned-version", "foreign"]), {
    valid: true,
  })
  await expect(Sharing.history(source(unknown).reader)).rejects.toThrow("indexes differ")

  const cursor = new Map(rows)
  cursor.set(JSON.stringify([...Projection.generationPrefix(session.sessionID, 1), "preparation-v3"]), {
    schemaVersion: 3,
    cursor: "0000000000000009",
    complete: true,
  })
  await expect(Sharing.history(source(cursor).reader)).rejects.toThrow("indexes differ")

  const last: Sync.Event = {
    type: "message",
    sequence: 5,
    messageID: "last-retained-message",
    role: "assistant",
    createdAt: 2,
    summary: "last accepted version",
    integrity: "d".repeat(64),
  }
  const finalHash = digest(JSON.stringify({ firstSeq: 5, lastSeq: 5, events: [last] }))
  const ack = await f.run(
    async () =>
      await f.sync({
        schemaVersion: 1,
        sessionID: session.sessionID,
        projectID: session.projectID,
        bindingEpoch: session.bindingEpoch,
        shareGeneration: 1,
        firstSeq: 5,
        lastSeq: 5,
        events: [last],
        payloadHash: finalHash,
      }),
  )
  expect(ack.nextSeq).toBe(6)
  const before = await f.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  await f.run(() => Sharing.unshare(f.credentials.alice, session.sessionID, { expectedShareGeneration: 1 }))
  const revoked = await f.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const families = new Set([
    "shared-events",
    "shared-sessions",
    "shared-batches",
    "transcript",
    "task-projection",
    "shared-blobs",
  ])
  for (const [key, value] of before) {
    const address = z.array(z.string()).parse(JSON.parse(key))
    if (
      address[0] === "organization" &&
      families.has(address[1]!) &&
      address[2] === session.sessionID &&
      address[3] === "1"
    )
      expect(revoked.get(key)).toEqual(value)
  }
  const restored = source(revoked)
  await Sharing.history(restored.reader)
  expect(restored.reader.read(Record.SessionDirectory, Keys.session(session.sessionID))).toMatchObject({
    shareState: "private",
    shareGeneration: 2,
  })
  expect(restored.reader.read(Record.SharedState, Keys.sharedState(session.sessionID))).toMatchObject({
    shareGeneration: 2,
    syncState: "blocked",
    nextSeq: 1,
  })
  expect(restored.accepted.has(JSON.stringify(Keys.sharedEvent(session.sessionID, 1, 5)))).toBe(true)
  expect(restored.accepted.has(JSON.stringify(Keys.sharedBatch(session.sessionID, 1, 5)))).toBe(true)

  const suffix = new Map(revoked)
  suffix.delete(JSON.stringify(Keys.sharedEvent(session.sessionID, 1, 5)))
  suffix.delete(JSON.stringify(Keys.sharedBatch(session.sessionID, 1, 5)))
  await expect(Sharing.history(source(suffix).reader)).rejects.toThrow()
  const wholeGeneration = new Map(revoked)
  for (const key of wholeGeneration.keys()) {
    const address = z.array(z.string()).parse(JSON.parse(key))
    if (
      address[0] === "organization" &&
      families.has(address[1]!) &&
      address[2] === session.sessionID &&
      address[3] === "1"
    )
      wholeGeneration.delete(key)
  }
  await expect(Sharing.history(source(wholeGeneration).reader)).rejects.toThrow()
  const missingClosure = new Map(revoked)
  missingClosure.delete(JSON.stringify(["organization", "shared-generations", session.sessionID, "1"]))
  await expect(Sharing.history(source(missingClosure).reader)).rejects.toThrow()
  await Sharing.history(source(revoked).reader)
})

// Construct the released writer's first-commit shape; no already published history is rewritten.
test("the owning maintenance transform seals legacy retained inventory without claiming an original ACK", async () => {
  await using f = await sharedProducerFixture()
  const sessionID = "legacy-retained-transcript"
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
  )
  const directory = await f.run(() => Directory.get(f.credentials.alice, sessionID))
  await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
  const events: Sync.Event[] = [
    {
      type: "session",
      sequence: 1,
      session: {
        sessionID,
        projectID: directory.projectID,
        creatorID: directory.creatorID,
        driverRuntimeID: directory.driverRuntimeID,
        bindingEpoch: directory.bindingEpoch,
        createdAt: directory.createdAt,
        shareGeneration: 1,
      },
    },
  ]
  const ack = await f.run(
    async () =>
      await f.sync({
        schemaVersion: 1,
        sessionID,
        projectID: directory.projectID,
        bindingEpoch: directory.bindingEpoch,
        shareGeneration: 1,
        firstSeq: 1,
        lastSeq: 1,
        payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 1, events })),
        events,
      }),
  )
  expect(ack.nextSeq).toBe(2)
  let firstWrites = 0
  await f.run(async () => {
    const original = StoreTransaction.prototype.write
    using firstWriter = spyOn(StoreTransaction.prototype, "write").mockImplementation(function (
      this: StoreTransaction,
      key,
      value,
      options,
    ) {
      if (
        Storage.current().transaction === this &&
        JSON.stringify(key) === JSON.stringify(Generations.key(sessionID, 1))
      ) {
        firstWrites++
        return Promise.resolve()
      }
      return original.call(this, key, value, options)
    })
    await Sharing.unshare(f.credentials.alice, sessionID, { expectedShareGeneration: 1 })
  })
  expect(firstWrites).toBe(1)
  const snapshot = () =>
    f.run(() =>
      Storage.snapshot(async (tx) => {
        const rows: Rows = new Map()
        for await (const entry of tx.exportEntries())
          if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
        return rows
      }),
    )
  const legacy = await snapshot()
  await expect(Sharing.history(source(legacy).reader)).rejects.toThrow()
  const cancelled = new Error("The original held maintenance owner ended")
  let pageWritten = false
  const interrupted = await Promise.resolve(
    f.run(async () => {
      const original = StoreTransaction.prototype.write
      using observe = spyOn(StoreTransaction.prototype, "write").mockImplementation(function (
        this: StoreTransaction,
        key,
        value,
        options,
      ) {
        if (
          Storage.current().transaction === this &&
          key[1] === "shared-generations" &&
          key[2] === sessionID &&
          key[4] === "inventory"
        )
          pageWritten = true
        return original.call(this, key, value, options)
      })
      return await Generations.upgrade(
        () => {
          if (pageWritten) throw cancelled
        },
        () => {},
      )
    }),
  ).then(
    () => ({ completed: true as const }),
    (error: unknown) => ({ completed: false as const, error }),
  )
  expect(pageWritten).toBe(true)
  expect(interrupted.completed).toBe(false)
  if (interrupted.completed) throw new Error("The cancelled native maintenance transform unexpectedly completed")
  expect(interrupted.error).toBe(cancelled)
  expect(await snapshot()).toEqual(legacy)
  await f.run(() =>
    Generations.upgrade(
      () => {},
      () => {},
    ),
  )
  const upgraded = await snapshot()
  for (const [key, value] of legacy) expect(upgraded.get(key)).toEqual(value)
  const closed = Generations.Closed.parse(upgraded.get(JSON.stringify(Generations.key(sessionID, 1))))
  expect(closed.proof.kind).toBe("retained-inventory")
  if (closed.proof.kind !== "retained-inventory")
    throw new Error("Legacy inventory was relabeled as an original unshare")
  expect(closed.proof.retainedNextSeq).toBe(2)
  expect(closed.proof.records).toBeGreaterThan(0)
  expect(closed.proof.families.map((item) => item.family)).toEqual([...Generations.generationFamilies])
  await Sharing.history(source(upgraded).reader)
  await f.run(() =>
    Generations.upgrade(
      () => {},
      () => {},
    ),
  )
  expect(await snapshot()).toEqual(upgraded)
  const omitted = new Map(upgraded)
  omitted.delete(JSON.stringify(Keys.sharedEvent(sessionID, 1, 1)))
  omitted.delete(JSON.stringify(Keys.sharedBatch(sessionID, 1, 1)))
  await expect(Sharing.history(source(omitted).reader)).rejects.toThrow()
  const appended = new Map(upgraded)
  appended.set(JSON.stringify(["organization", "transcript", sessionID, "1", "unowned-retained-row"]), { value: true })
  await expect(Sharing.history(source(appended).reader)).rejects.toThrow()
  const page = [...upgraded.keys()].find((key) => {
    const address = z.array(z.string()).parse(JSON.parse(key))
    return address[1] === "shared-generations" && address[2] === sessionID && address[4] === "inventory"
  })
  if (!page) throw new Error("The original maintenance transform did not persist its bounded inventory")
  const missingPage = new Map(upgraded)
  missingPage.delete(page)
  await expect(Sharing.history(source(missingPage).reader)).rejects.toThrow()
  await Sharing.history(source(upgraded).reader)
})

for (const mode of ["empty-pending", "committed-before-reply-failure"] as const)
  test(`unshare retains ${mode} without inventing Native ACK delivery`, async () => {
    await using f = await sharedProducerFixture()
    const sessionID = "revoked-" + mode
    await f.run(() =>
      Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
    )
    const directory = await f.run(() => Directory.get(f.credentials.alice, sessionID))
    await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
    if (mode === "committed-before-reply-failure") {
      const events: Sync.Event[] = [
        {
          type: "session",
          sequence: 1,
          session: {
            sessionID,
            projectID: directory.projectID,
            creatorID: directory.creatorID,
            driverRuntimeID: directory.driverRuntimeID,
            bindingEpoch: directory.bindingEpoch,
            createdAt: directory.createdAt,
            shareGeneration: 1,
          },
        },
      ]
      const apply = Sharing.applyBatchFromRuntime
      using reply = spyOn(Sharing, "applyBatchFromRuntime").mockImplementation(async (...args) => {
        await apply(...args)
        throw new Error("The original batch committed before its reply was delivered")
      })
      const result = await Promise.resolve(
        f.run(
          async () =>
            await f.sync({
              schemaVersion: 1,
              sessionID,
              projectID: directory.projectID,
              bindingEpoch: directory.bindingEpoch,
              shareGeneration: 1,
              firstSeq: 1,
              lastSeq: 1,
              payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 1, events })),
              events,
            }),
        ),
      ).then(
        () => ({ delivered: true }),
        () => ({ delivered: false }),
      )
      expect(result.delivered).toBe(false)
    }
    const state = await f.run(() => Record.read(Record.SharedState, Keys.sharedState(sessionID)))
    if (!state) throw new Error("The actual shared producer has no original state")
    expect(state).toMatchObject({
      syncState: mode === "empty-pending" ? "pending" : "synced",
      nextSeq: mode === "empty-pending" ? 1 : 2,
    })
    await f.run(() => Sharing.unshare(f.credentials.alice, sessionID, { expectedShareGeneration: 1 }))
    const rows = await f.run(() =>
      Storage.snapshot(async (tx) => {
        const rows: Rows = new Map()
        for await (const entry of tx.exportEntries())
          if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
        return rows
      }),
    )
    const closed = Generations.Closed.parse(rows.get(JSON.stringify(Generations.key(sessionID, 1))))
    expect(closed.proof.kind).toBe("unshare")
    if (closed.proof.kind !== "unshare") throw new Error("A current unshare was relabeled as legacy inventory")
    expect(closed.proof.state).toEqual(state)
    expect(closed.proof.terminalBatch === null).toBe(mode === "empty-pending")
    await Sharing.history(source(rows).reader)
    expect(source(rows).reader.read(Record.SessionDirectory, Keys.session(sessionID))).toMatchObject({
      shareState: "private",
      shareGeneration: 2,
    })
  })

test("legacy empty retained generations use one finite range and retain private authorization", async () => {
  await using f = await sharedProducerFixture()
  const sessionID = "empty-legacy-generations"
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
  )
  const privateGeneration = 1_000_000_000
  await f.run(() =>
    Storage.transaction(async () => {
      const current = await Record.read(Record.SessionDirectory, Keys.session(sessionID))
      if (!current) throw new Error("Missing original private directory")
      await Storage.write(
        Keys.session(sessionID),
        Record.SessionDirectory.parse({ ...current, shareGeneration: privateGeneration }),
      )
      await Storage.write(
        Keys.sharedState(sessionID),
        Record.SharedState.parse({
          schemaVersion: 1,
          sessionID,
          shareGeneration: privateGeneration,
          bindingEpoch: current.bindingEpoch,
          nextSeq: 1,
          syncState: "blocked",
          updatedAt: 1,
        }),
      )
    }),
  )
  const snapshot = () =>
    f.run(() =>
      Storage.snapshot(async (tx) => {
        const rows: Rows = new Map()
        for await (const entry of tx.exportEntries())
          if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
        return rows
      }),
    )
  const legacy = await snapshot()
  await f.run(() =>
    Generations.upgrade(
      () => {},
      () => {},
    ),
  )
  const rows = await snapshot()
  for (const [key, value] of legacy) expect(rows.get(key)).toEqual(value)
  const ranges = [...source(rows).reader.entries([...Generations.emptyRoot, sessionID])]
  expect(ranges).toHaveLength(1)
  const range = Generations.EmptyRange.parse(ranges[0]!.value)
  expect(range).toMatchObject({
    provenance: "retained-empty-inventory",
    firstGeneration: 1,
    lastGeneration: privateGeneration - 1,
  })
  expect([...source(rows).reader.entries([...Generations.root, sessionID])]).toHaveLength(0)
  await Sharing.history(source(rows).reader)
  await expect(f.run(() => Sharing.snapshot(f.credentials.bob, sessionID, { limit: 10 }))).rejects.toThrow()
  const hidden = new Map(rows)
  hidden.set(JSON.stringify(Keys.sharedEvent(sessionID, 1, 1)), {
    schemaVersion: 1,
    event: {
      type: "message",
      sequence: 1,
      messageID: "cannot-be-hidden",
      role: "user",
      createdAt: 1,
      summary: "",
      integrity: "a".repeat(64),
    },
  })
  await expect(Sharing.history(source(hidden).reader)).rejects.toThrow("empty inventory cannot hide")
  const absent = new Map(rows)
  absent.delete(JSON.stringify(ranges[0]!.key))
  await expect(Sharing.history(source(absent).reader)).rejects.toThrow()
  await Sharing.history(source(rows).reader)
})

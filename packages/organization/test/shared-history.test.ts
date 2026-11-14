import { expect, test } from "bun:test"
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
})

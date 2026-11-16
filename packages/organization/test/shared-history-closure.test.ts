import { expect, test } from "bun:test"
import { z } from "zod"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationSharedHistory } from "../src/shared-history"
import { OrganizationSharedTasks as Tasks } from "../src/shared-tasks"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { sharedProducerFixture } from "./support/shared-producer"

type Fixture = Awaited<ReturnType<typeof sharedProducerFixture>>
type Rows = Map<string, unknown>
async function rows(f: Fixture) {
  return f.run(() =>
    Storage.snapshot(async (tx) => {
      const result: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") result.set(JSON.stringify(entry.key), entry.value)
      return result
    }),
  )
}
function historical(f: Fixture, rows: Rows) {
  const accepted = new Set<string>()
  const groups = new Map<string, string>()
  const reader: OrganizationSharedHistory.Source = {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing original closure row")
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
      if (previous !== undefined && previous !== hash) throw new Error("Changed original closure group")
      if (previous !== undefined) return false
      groups.set(id, hash)
      return true
    },
    async binary(key, maximum) {
      return f.run(() => Storage.readBinary(key, { maxBytes: maximum }))
    },
  }
  return {
    accepted,
    source: reader,
  }
}
async function shared(f: Fixture, id: string, attachment?: { hash: string; bytes: number }) {
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, { sessionID: id, projectID: "project", runtimeID: "runtime-alice" }),
  )
  const session = await f.run(() => Directory.get(f.credentials.alice, id))
  await f.run(() => Sharing.share(f.credentials.alice, id, { expectedShareGeneration: 0 }))
  const events: Sync.Event[] = [
    {
      type: "session",
      sequence: 1,
      session: {
        sessionID: id,
        projectID: session.projectID,
        creatorID: session.creatorID,
        driverRuntimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
        createdAt: session.createdAt,
        shareGeneration: 1,
      },
    },
  ]
  if (attachment)
    events.push({
      type: "attachment",
      sequence: 2,
      attachmentID: "actual-upload",
      filename: "original.bin",
      mediaType: "application/octet-stream",
      ...attachment,
      state: "available",
    })
  return {
    session,
    events,
    async sync() {
      const canonical = events.map((event) => Sync.Event.parse(event))
      const firstSeq = 1,
        lastSeq = canonical.length
      return f.run(() =>
        f.sync({
          schemaVersion: 1,
          sessionID: id,
          projectID: session.projectID,
          bindingEpoch: session.bindingEpoch,
          shareGeneration: 1,
          firstSeq,
          lastSeq,
          events: canonical,
          payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events: canonical })),
        }),
      )
    },
  }
}

test("historical sharing rejects a changed real lazy task checkpoint pointer", async () => {
  await using f = await sharedProducerFixture()
  const original = await shared(f, "history-tasks")
  await original.sync()
  await f.run(() => Sharing.tasks(f.credentials.bob, original.session.sessionID, { limit: 1 }))
  const snapshot = await rows(f)
  const valid = historical(f, snapshot)
  await Sharing.history(valid.source)
  const prefix = Tasks.generationPrefix(original.session.sessionID, 1)
  const version = [...snapshot].find(([key]) => {
    const parsed = z.array(z.string()).parse(JSON.parse(key))
    return prefix.every((part, index) => parsed[index] === part) && parsed[4] === "versions"
  })
  if (!version) throw new Error("The actual Tasks reader did not prepare its native version index")
  const changed = new Map(snapshot)
  changed.set(version[0], { sequence: 999 })
  await expect(Promise.resolve().then(() => Sharing.history(historical(f, changed).source))).rejects.toThrow()
  expect(valid.accepted.has(JSON.stringify([...prefix, "checkpoint"]))).toBe(true)
})

test("historical sharing verifies actual uploaded native bytes rather than only its complete manifest", async () => {
  await using f = await sharedProducerFixture()
  const bytes = Uint8Array.from([0, 255, 17, 128, 3, 42])
  const hash = createHash("sha256").update(bytes).digest("hex")
  const original = await shared(f, "history-binary", { hash, bytes: bytes.byteLength })
  const uploaded = await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, original.session.sessionID, {
      shareGeneration: 1,
      hash,
      offset: 0,
      totalBytes: bytes.byteLength,
      bytes,
    }),
  )
  expect(uploaded.complete).toBe(true)
  await original.sync()
  const snapshot = await rows(f)
  const valid = historical(f, snapshot)
  await Sharing.history(valid.source)
  const manifestKey = Keys.sharedBlob(original.session.sessionID, 1, hash)
  const manifest = valid.source.read(Record.SharedBlob, manifestKey)
  const incomplete = new Map(snapshot)
  incomplete.set(JSON.stringify(manifestKey), { ...manifest, complete: false })
  await expect(Sharing.history(historical(f, incomplete).source)).rejects.toThrow()
  const receipt = [...snapshot.keys()].find((key) => {
    const parsed = z.array(z.string()).parse(JSON.parse(key))
    return manifestKey.every((part, index) => parsed[index] === part) && parsed[5] === "chunk-manifest"
  })
  if (!receipt) throw new Error("The actual native upload has no chunk receipt")
  const missing = new Map(snapshot)
  missing.delete(receipt)
  await expect(Sharing.history(historical(f, missing).source)).rejects.toThrow("byte closure")
  const unknown = new Map(snapshot)
  unknown.set(JSON.stringify([...manifestKey, "unowned-version"]), { offset: 0, bytes: bytes.byteLength })
  await expect(Sharing.history(historical(f, unknown).source)).rejects.toThrow("byte closure")
  const chunk = Keys.sharedBlobChunk(original.session.sessionID, 1, hash, 0)
  await f.run(() => Storage.writeBinary(chunk, Uint8Array.from([0, 255, 17, 128, 3, 43])))
  await expect(Promise.resolve().then(() => Sharing.history(historical(f, snapshot).source))).rejects.toThrow()
  expect(valid.accepted.has(JSON.stringify(Keys.sharedBlob(original.session.sessionID, 1, hash)))).toBe(true)
})

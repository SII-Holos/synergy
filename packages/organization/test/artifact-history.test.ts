import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { StorageEntry } from "@ericsanchezok/synergy-harness/storage/portable"
import { OrganizationArtifacts as Artifacts } from "../src/artifacts"
import { OrganizationPublications as Publications } from "../src/publications"
import { OrganizationSessionDirectory } from "../src/session-directory"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord } from "../src/storage/records"
import { directoryFixture } from "./support/session-directory"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
async function artifactFixture() {
  const f = await directoryFixture()
  try {
    const versions = await f.run(async () => {
      await OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
        sessionID: "source",
        projectID: "project",
        runtimeID: "runtime-alice",
      })
      const versions = []
      for (const version of [1, 2]) {
        const bytes = Uint8Array.from([0, 255, version, 19])
        const upload = await Publications.create(f.credentials.alice, {
          requestID: "create-" + version,
          purpose: "artifact",
          scope: { kind: "project", projectID: "project" },
          sourceSessionID: "source",
        })
        const file = await Publications.putFile(f.credentials.alice, upload.uploadID, {
          path: "result.bin",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mediaType: "application/octet-stream",
        })
        await Publications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
        await Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length })
        const published = await Artifacts.publish(f.credentials.alice, {
          requestID: "publish-" + version,
          artifactID: "output",
          expectedRevision: version - 1,
          uploadID: upload.uploadID,
          title: "Output " + version,
        })
        versions.push({ upload, file, published, bytes })
      }
      return versions
    })
    return { ...f, versions }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

async function inspect(f: Awaited<ReturnType<typeof artifactFixture>>) {
  return f.run(() =>
    Storage.withArtifactCheckpoint((checkpoint) =>
      Storage.snapshot(async (tx) => {
        const records = new Map<string, { key: string[]; value: unknown }>()
        const all: StorageEntry[] = []
        for await (const entry of tx.exportEntries()) all.push(entry)
        for (const entry of all) if (entry.type === "record") records.set(JSON.stringify(entry.key), entry)
        const accepted = new Set<string>()
        const groups = new Map<string, string>()
        const reader: Publications.HistoricalSource = {
          read(schema, key) {
            return schema.parse(records.get(JSON.stringify(key))?.value)
          },
          *entries(prefix) {
            for (const row of [...records.values()].sort((a, b) =>
              JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)),
            ))
              if (row.key.length > prefix.length && prefix.every((value, index) => value === row.key[index])) yield row
          },
          accept(key) {
            accepted.add(JSON.stringify(key))
          },
          first(key, value) {
            const id = JSON.stringify(key),
              digest = hash(value),
              previous = groups.get(id)
            if (previous) {
              if (previous !== digest) throw new Error("Historical owner reference changed")
              return false
            }
            groups.set(id, digest)
            return true
          },
          async binary(key) {
            const entry = all.find(
              (entry) => entry.type === "artifact" && JSON.stringify(entry.key) === JSON.stringify(key),
            )
            if (!entry || entry.type !== "artifact") throw new Error("Missing actual historical bytes")
            const chunks = []
            for await (const chunk of checkpoint.stream(entry.location)) chunks.push(Uint8Array.from(chunk))
            return Uint8Array.from(Buffer.concat(chunks))
          },
        }
        Publications.historicalRequests(reader)
        await Artifacts.history(reader)
        expect(
          [...records.values()].filter(
            (row) =>
              ["organization-artifacts", "organization-publications"].includes(row.key[0]) &&
              !accepted.has(JSON.stringify(row.key)),
          ),
        ).toEqual([])
      }),
    ),
  )
}

test("Artifact history retains versions and author snapshots after the original source disappears", async () => {
  await using f = await artifactFixture()
  await f.run(async () => {
    await Storage.remove(Keys.session("source"))
    const account = await OrganizationRecord.read(OrganizationRecord.Account, Keys.account("alice"))
    if (!account) throw new Error("Missing original artifact author")
    await Storage.write(Keys.account("alice"), { ...account, displayName: "Renamed", state: "removed" })
  })
  await f.restart()
  await inspect(f)
  const version = await f.run(() => Artifacts.get(f.credentials.reader, "output", 1))
  expect(version.sourceAvailable).toBe(false)
  expect(version.author?.displayName).toBe("alice")
  const first = f.versions[0]
  if (!first) throw new Error("Missing original first version")
  const content = await f.run(() => Artifacts.content(f.credentials.reader, "output", 1, first.file.fileID))
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(first.bytes)
})

for (const missing of ["version", "index", "receipt"] as const) {
  test(`Artifact history rejects a missing original ${missing}`, async () => {
    await using f = await artifactFixture()
    const key =
      missing === "version"
        ? ["organization-artifacts", "versions", "org", "output", "0000000000000001"]
        : missing === "index"
          ? ["organization-artifacts", "index", "org", "project", "output"]
          : ["organization-artifacts", "receipts", "org", "alice", "publish-1"]
    await f.run(() => Storage.remove(key))
    await expect(inspect(f)).rejects.toThrow()
  })
}

test("Artifact history rejects a version whose sealed upload names another original source", async () => {
  await using f = await artifactFixture()
  await f.run(async () => {
    const key = ["organization-artifacts", "versions", "org", "output", "0000000000000001"]
    const [version] = await Storage.readMany<Record<string, unknown>>([key])
    if (!version) throw new Error("Missing original artifact version")
    await Storage.write(key, { ...version, sourceSessionID: "another-source" })
  })
  await expect(inspect(f)).rejects.toThrow("original sealed release")
})

import { StorageBootstrapBase } from "./bootstrap-base"
import { bootstrapPhysicalRecordRoots } from "./bootstrap-layout"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { Storage } from "./storage"
import { StoragePortable, StorageEntry } from "./portable"
import { StorageConflictError, StorageIntegrityError } from "./errors"
import { fileDigest } from "./file-digest"
import { SecretEnvelope, type VaultKeyProvider } from "../secrets/encrypted-store"
import type { StoreTransaction } from "./transactional-store"
import { RuntimeContext } from "../lifecycle/context"
import { initializeSqliteEngine } from "./sqlite-engine"
import { ArtifactLocation } from "./artifact-location"
import { HomeRestoration } from "../lifecycle/home-restoration"

const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Count = z.number().int().nonnegative().safe()
const secretRoot = "storage_checkpoint_secret"
const stagingRoot = "storage_checkpoint_staging"
const maxSecretBytes = 32 * 1024 * 1024
const Marker = z.strictObject({
  format: z.literal("synergy-checkpoint-secret"),
  version: z.literal(1),
  archiveID: ID,
  namespaceID: ID,
  index: Count,
  keyVersion: z.string().min(1).max(128),
  sha256: Hash,
  bytes: Count,
})
const PreparationReceipt = z.strictObject({
  operationID: z.string().min(1).max(128),
  requestHash: Hash,
  result: z.literal('{"value":true}'),
})
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const physical = (root: string) => root === "storage_pack_pins" || root.startsWith("storage_object_")

async function checkedFile(
  root: string,
  directory: "objects" | "secrets" | undefined,
  name: string,
  expected?: { bytes: number; sha256: string },
) {
  const parent = directory ? path.join(root, directory) : root
  const parentInfo = await fs.lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new StorageIntegrityError("Checkpoint directories cannot be symbolic links")
  const filename = path.join(parent, name)
  const info = await fs.lstat(filename)
  if (!info.isFile() || info.isSymbolicLink())
    throw new StorageIntegrityError("Checkpoint content must be an ordinary file")
  if (expected && (info.size !== expected.bytes || (await fileDigest(filename, expected.bytes)) !== expected.sha256))
    throw new StorageIntegrityError("Checkpoint content integrity mismatch")
  return { filename, bytes: info.size, device: info.dev, inode: info.ino }
}

async function writeFile(filename: string, bytes: Uint8Array | string) {
  const handle = await fs.open(filename, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export namespace StorageCheckpoint {
  export const Manifest = z.strictObject({
    format: z.literal("synergy-storage-checkpoint"),
    version: z.literal(1),
    archiveID: ID,
    namespaceID: ID,
    buildVersion: z.string().min(1).max(200),
    createdAt: Count,
    records: z.strictObject({ bytes: Count, sha256: Hash, entries: Count }),
    artifactReferences: Count,
    referencedBytes: Count,
    secretEntries: Count,
  })
  export type Manifest = z.infer<typeof Manifest>
  export interface ImportEvidence {
    readonly kind: "storage-checkpoint-import"
    readonly restoreID: string
  }
  const imported = new WeakMap<
    ImportEvidence,
    { assert(tx: StoreTransaction): void; manifest: Readonly<Manifest>; guards: Array<() => void> }
  >()
  export function assertImport(evidence: ImportEvidence, tx: StoreTransaction): Readonly<Manifest> {
    const original = imported.get(evidence)
    if (!original) throw new StorageIntegrityError("Checkpoint import requires original native evidence")
    original.assert(tx)
    return original.manifest
  }
  export function guardImport(evidence: ImportEvidence, tx: StoreTransaction, guard: () => void) {
    assertImport(evidence, tx)
    imported.get(evidence)!.guards.push(guard)
  }

  export async function* streamArtifact(input: {
    directory: string
    location: { sha256: string; size: number }
    signal?: AbortSignal
  }): AsyncGenerator<Uint8Array> {
    if (!path.isAbsolute(input.directory)) throw new StorageIntegrityError("Checkpoint source must be absolute")
    const expected = { sha256: Hash.parse(input.location.sha256), size: Count.parse(input.location.size) }
    input.signal?.throwIfAborted()
    const selected = await checkedFile(path.resolve(input.directory), "objects", `${expected.sha256}.bin`)
    if (selected.bytes !== expected.size) throw new StorageIntegrityError("Checkpoint artifact integrity mismatch")
    const file = await fs.open(selected.filename, "r")
    let completed = false
    let failed = false
    try {
      const opened = await file.stat()
      if (
        !opened.isFile() ||
        opened.dev !== selected.device ||
        opened.ino !== selected.inode ||
        opened.size !== expected.size
      )
        throw new StorageIntegrityError("Checkpoint artifact changed during opening")
      const hash = createHash("sha256")
      let bytes = 0
      for (;;) {
        input.signal?.throwIfAborted()
        const chunk = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, expected.size - bytes + 1))
        const read = await file.read(chunk, 0, chunk.length, null)
        if (!read.bytesRead) break
        bytes += read.bytesRead
        if (bytes > expected.size) throw new StorageIntegrityError("Checkpoint artifact integrity mismatch")
        const value = chunk.subarray(0, read.bytesRead)
        hash.update(value)
        yield value
      }
      input.signal?.throwIfAborted()
      if (bytes !== expected.size || hash.digest("hex") !== expected.sha256)
        throw new StorageIntegrityError("Checkpoint artifact integrity mismatch")
      completed = true
    } catch (error) {
      failed = true
      throw error
    } finally {
      await file.close()
      if (!completed && !failed) {
        input.signal?.throwIfAborted()
        throw new StorageIntegrityError("Checkpoint artifact scan must complete")
      }
    }
  }

  export async function exportArchive(input: {
    directory: string
    archiveID: string
    namespaceID: string
    buildVersion: string
    keys: VaultKeyProvider
    protect(entry: StorageEntry): boolean
    signal?: AbortSignal
  }): Promise<Manifest> {
    if (!path.isAbsolute(input.directory)) throw new StorageIntegrityError("Checkpoint destination must be absolute")
    ID.parse(input.archiveID)
    ID.parse(input.namespaceID)
    const destination = path.resolve(input.directory)
    const partial = `${destination}.partial-${randomUUID()}`
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await fs.mkdir(partial, { mode: 0o700 })
    let encryptionKey: Buffer | undefined
    try {
      const recovery = await input.keys.current()
      const backupKey = Buffer.from(recovery.key)
      encryptionKey = backupKey
      await fs.mkdir(path.join(partial, "objects"), { mode: 0o700 })
      await fs.mkdir(path.join(partial, "secrets"), { mode: 0o700 })
      let artifactReferences = 0
      let referencedBytes = 0
      let secretEntries = 0
      const recordFile = path.join(partial, "records.ndjson")
      async function copyArtifact(
        checkpoint: Storage.ArtifactCheckpoint,
        entry: Extract<StorageEntry, { type: "artifact" }>,
      ) {
        const filename = path.join(partial, "objects", `${entry.location.sha256}.bin`)
        const exists = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!exists) {
          const output = await fs.open(filename, "wx", 0o600)
          let bytes = 0
          const hash = createHash("sha256")
          try {
            for await (const chunk of checkpoint.stream(entry.location)) {
              input.signal?.throwIfAborted()
              bytes += chunk.length
              if (bytes > entry.location.size)
                throw new StorageIntegrityError("Checkpoint artifact grew during capture")
              hash.update(chunk)
              await output.writeFile(chunk)
            }
            if (bytes !== entry.location.size || hash.digest("hex") !== entry.location.sha256)
              throw new StorageIntegrityError("Checkpoint artifact does not match its frozen reference")
            await output.sync()
          } finally {
            await output.close()
          }
        } else
          await checkedFile(partial, "objects", `${entry.location.sha256}.bin`, {
            bytes: entry.location.size,
            sha256: entry.location.sha256,
          })
        artifactReferences++
        referencedBytes += entry.location.size
        if (!Number.isSafeInteger(referencedBytes))
          throw new StorageIntegrityError("Checkpoint byte count exceeds its physical format")
      }
      const exported = await Storage.withArtifactCheckpoint(
        async (checkpoint) => {
          const exported = await checkpoint.exportPortable(recordFile, {
            async transform(entry) {
              input.signal?.throwIfAborted()
              if (
                (entry.type === "record" || entry.type === "artifact") &&
                [secretRoot, stagingRoot].includes(entry.key[0])
              )
                throw new StorageIntegrityError(
                  "Unresolved checkpoint staging cannot become an ordinary namespace backup",
                )
              if (entry.type === "artifact") return entry
              if (!input.protect(entry)) return entry
              const bytes = Buffer.from(JSON.stringify(entry))
              if (bytes.length > maxSecretBytes)
                throw new StorageIntegrityError("A recovery record exceeds the native portable record bound")
              const index = secretEntries++
              let encoded: string
              try {
                encoded = JSON.stringify(
                  SecretEnvelope.seal({
                    authority: ["storage-checkpoint", input.archiveID, input.namespaceID],
                    id: String(index),
                    keyVersion: recovery.version,
                    key: backupKey,
                    bytes,
                  }),
                )
              } finally {
                bytes.fill(0)
              }
              const hash = sha256(encoded)
              await writeFile(path.join(partial, "secrets", `${hash}.json`), encoded)
              return {
                type: "record",
                key: [secretRoot, input.archiveID, input.namespaceID, String(index)],
                revision: "1",
                value: Marker.parse({
                  format: "synergy-checkpoint-secret",
                  version: 1,
                  archiveID: input.archiveID,
                  namespaceID: input.namespaceID,
                  index,
                  keyVersion: recovery.version,
                  sha256: hash,
                  bytes: Buffer.byteLength(encoded),
                }),
              }
            },
          })
          // Object manifest pages use SQL after the metadata snapshot closes; the artifact gate remains held.
          for await (const entry of StoragePortable.entries(recordFile)) {
            if (entry.type === "artifact") await copyArtifact(checkpoint, entry)
          }
          return exported
        },
        { signal: input.signal },
      )
      const records = await fs.stat(recordFile)
      const manifest = Manifest.parse({
        format: "synergy-storage-checkpoint",
        version: 1,
        archiveID: input.archiveID,
        namespaceID: input.namespaceID,
        buildVersion: input.buildVersion,
        createdAt: Date.now(),
        records: { bytes: records.size, sha256: await fileDigest(recordFile, records.size), entries: exported.count },
        artifactReferences,
        referencedBytes,
        secretEntries,
      })
      await writeFile(path.join(partial, "manifest.json"), JSON.stringify(manifest))
      input.signal?.throwIfAborted()
      await fs.rename(partial, destination)
      return manifest
    } catch (error) {
      await fs.rm(partial, { recursive: true, force: true })
      throw error
    } finally {
      encryptionKey?.fill(0)
    }
  }

  async function recoveryEntry(
    root: string,
    manifest: Manifest,
    entry: StorageEntry,
    keys: VaultKeyProvider,
  ): Promise<StorageEntry> {
    if (entry.type !== "record" || entry.key[0] !== secretRoot) return entry
    const marker = Marker.parse(entry.value)
    if (
      marker.archiveID !== manifest.archiveID ||
      marker.namespaceID !== manifest.namespaceID ||
      JSON.stringify(entry.key) !==
        JSON.stringify([secretRoot, marker.archiveID, marker.namespaceID, String(marker.index)])
    )
      throw new StorageIntegrityError("Recovery material belongs to another checkpoint")
    if (marker.bytes > maxSecretBytes * 2)
      throw new StorageIntegrityError("Recovery ciphertext exceeds the native record bound")
    const file = await checkedFile(root, "secrets", `${marker.sha256}.json`, marker)
    const envelope = SecretEnvelope.Ciphertext.parse(JSON.parse(await fs.readFile(file.filename, "utf8")))
    const key = await keys.resolve(marker.keyVersion)
    const bytes = SecretEnvelope.open({
      authority: ["storage-checkpoint", marker.archiveID, marker.namespaceID],
      id: String(marker.index),
      keyVersion: marker.keyVersion,
      key,
      envelope,
    })
    try {
      const recovered = StorageEntry.parse(JSON.parse(bytes.toString("utf8")))
      if ((recovered.type === "record" || recovered.type === "artifact") && recovered.key[0] === secretRoot)
        throw new StorageIntegrityError("Recursive recovery material is invalid")
      return recovered
    } finally {
      bytes.fill(0)
    }
  }

  async function* scanArchive(input: {
    directory: string
    keys: VaultKeyProvider
    expected?: Manifest
    signal?: AbortSignal
  }): AsyncGenerator<StorageEntry, Manifest> {
    input.signal?.throwIfAborted()
    const root = await fs.realpath(input.directory)
    const file = await checkedFile(root, undefined, "manifest.json")
    if (file.bytes > 64 * 1024) throw new StorageIntegrityError("Checkpoint manifest is too large")
    const manifest = Manifest.parse(JSON.parse(await fs.readFile(file.filename, "utf8")))
    if (input.expected && JSON.stringify(manifest) !== JSON.stringify(Manifest.parse(input.expected)))
      throw new StorageIntegrityError("Checkpoint archive does not match its captured manifest")
    const records = await checkedFile(root, undefined, "records.ndjson")
    if (records.bytes !== manifest.records.bytes)
      throw new StorageIntegrityError("Checkpoint portable size does not match its manifest")
    let count = 0
    let artifactReferences = 0
    let referencedBytes = 0
    let secretEntries = 0
    const hash = createHash("sha256")
    let bytes = 0
    let complete = false
    let failed = false
    try {
      for await (const stored of StoragePortable.entries(records.filename, (line) => {
        hash.update(line + "\n")
        bytes += Buffer.byteLength(line) + 1
      })) {
        input.signal?.throwIfAborted()
        count++
        if (stored.type === "record" && stored.key[0] === secretRoot) {
          if (Marker.parse(stored.value).index !== secretEntries)
            throw new StorageIntegrityError("Recovery material sequence is incomplete")
          secretEntries++
        }
        const entry = await recoveryEntry(root, manifest, stored, input.keys)
        if (entry.type === "artifact") {
          artifactReferences++
          referencedBytes += entry.location.size
          await checkedFile(root, "objects", `${entry.location.sha256}.bin`, {
            bytes: entry.location.size,
            sha256: entry.location.sha256,
          })
        }
        input.signal?.throwIfAborted()
        yield entry
      }
      input.signal?.throwIfAborted()
      if (
        count !== manifest.records.entries ||
        bytes !== manifest.records.bytes ||
        hash.digest("hex") !== manifest.records.sha256 ||
        artifactReferences !== manifest.artifactReferences ||
        referencedBytes !== manifest.referencedBytes ||
        secretEntries !== manifest.secretEntries
      )
        throw new StorageIntegrityError("Checkpoint inventory is incomplete or changed during inspection")
      complete = true
      return manifest
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (!complete && !failed)
        throw new StorageIntegrityError("Checkpoint logical entry scan must complete before capture is verified")
    }
  }

  export async function* entries(input: {
    directory: string
    keys: VaultKeyProvider
    expected?: Manifest
    signal?: AbortSignal
  }): AsyncGenerator<StorageEntry> {
    yield* scanArchive(input)
  }

  export async function verifyArchive(input: {
    directory: string
    keys: VaultKeyProvider
    expected?: Manifest
    signal?: AbortSignal
  }): Promise<Manifest> {
    const entries = scanArchive(input)
    for (;;) {
      const next = await entries.next()
      if (next.done) return next.value
    }
  }

  export interface PreparedArtifacts {
    readonly kind: "storage-checkpoint-prepared-artifacts"
  }
  type ArtifactPreparation = {
    database: Database
    prefix: string[]
    assert(): void
    checkStaging(tx: StoreTransaction): Promise<void>
  }
  const artifactPreparations = new WeakMap<PreparedArtifacts, ArtifactPreparation>()
  const artifactPublications = new WeakMap<
    StoreTransaction,
    { preparation: ArtifactPreparation; complete: boolean; failed: boolean }
  >()
  function preparation(evidence: PreparedArtifacts) {
    const selected = artifactPreparations.get(evidence)
    if (!selected) throw new StorageIntegrityError("Artifact staging requires its original checkpoint preparation")
    selected.assert()
    return selected
  }
  export function acceptsStagedArtifact(evidence: PreparedArtifacts, key: string[], location: ArtifactLocation) {
    const selected = preparation(evidence)
    using query = selected.database.query<{ location: string | null }, [string]>(
      "SELECT location FROM selected WHERE staged=?",
    )
    const row = query.get(JSON.stringify(key))
    return !!row?.location && row.location === JSON.stringify(ArtifactLocation.parse(location))
  }
  export async function withPreparedArtifacts<T>(
    input: {
      directory: string
      expected: Manifest
      keys: VaultKeyProvider
      restoreID: string
      installationID: string
      bindingHash: string
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
      references: AsyncIterable<string[]> | Iterable<string[]>
      transaction<R>(body: (tx: StoreTransaction) => Promise<R>): Promise<R>
      signal?: AbortSignal
    },
    body: (prepared: PreparedArtifacts) => Promise<T>,
  ): Promise<T> {
    if (Storage.inTransaction())
      throw new StorageConflictError("Artifact staging requires its native preparation boundary")
    const expected = Manifest.parse(structuredClone(input.expected))
    const restoreID = ID.parse(input.restoreID)
    const installationID = ID.parse(input.installationID)
    const bindingHash = Hash.parse(input.bindingHash)
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const directory = input.directory
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const signal = input.signal
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const configuration = JSON.stringify(store.options)
    const artifacts = handle.artifactDirectory
    if (handle.artifactObjects)
      throw new StorageConflictError("Checkpoint delta staging requires its native artifact owner")
    let open = true
    const assert = () => {
      signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      const installed = HomeRestoration.assertInstalledOwner(permit)
      if (installed.installationID !== installationID || HomeRestoration.describe(permit).restoreID !== restoreID)
        throw new StorageConflictError("Checkpoint preparation requires its original native installation")
      if (
        !open ||
        RuntimeContext.current() !== runtime ||
        RuntimeContext.current().storage !== handle ||
        Storage.current().store !== store ||
        handle.store !== store ||
        JSON.stringify(store.options) !== configuration ||
        Storage.current().artifactDirectory !== artifacts ||
        handle.artifactDirectory !== artifacts ||
        Storage.current().artifactObjects ||
        handle.artifactObjects
      )
        throw new StorageConflictError("Checkpoint artifact preparation belongs to another native target")
    }
    assert()
    initializeSqliteEngine()
    const temporary = await fs.mkdtemp(path.join(tmpdir(), "synergy-checkpoint-artifacts-"))
    const database = new Database(path.join(temporary, "artifacts.sqlite"))
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE artifacts(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE selected(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,size INTEGER NOT NULL,staged TEXT UNIQUE,location TEXT)",
    )
    try {
      using insert = database.query("INSERT INTO artifacts VALUES(?,?,?)")
      for await (const entry of entries({ directory, expected, keys, signal })) {
        assert()
        if (entry.type === "artifact") insert.run(JSON.stringify(entry.key), entry.location.sha256, entry.location.size)
      }
      using artifact = database.query<{ sha256: string; size: number }, [string]>(
        "SELECT sha256,size FROM artifacts WHERE key=?",
      )
      using select = database.query("INSERT INTO selected(key,sha256,size) VALUES(?,?,?)")
      for await (const key of input.references) {
        assert()
        const text = JSON.stringify(z.array(z.string().min(1)).min(1).parse(key))
        const row = artifact.get(text)
        if (!row) throw new StorageIntegrityError("Selected artifact is absent from its complete checkpoint")
        select.run(text, row.sha256, row.size)
      }
      const checksum = createHash("sha256")
      using ordered = database.query<{ key: string; sha256: string; size: number }, []>(
        "SELECT key,sha256,size FROM selected ORDER BY key",
      )
      for (const row of ordered.iterate()) checksum.update(JSON.stringify(row) + "\n")
      const prefix = [stagingRoot, restoreID, "artifacts", installationID, sha256(bindingHash + checksum.digest("hex"))]
      using staged = database.query("UPDATE selected SET staged=? WHERE key=?")
      for (const row of ordered.iterate()) staged.run(JSON.stringify([...prefix, sha256(row.key)]), row.key)
      const selected: ArtifactPreparation = { database, prefix, assert, checkStaging: (tx) => checkStaging(tx, true) }
      const evidence: PreparedArtifacts = Object.freeze({ kind: "storage-checkpoint-prepared-artifacts" })
      artifactPreparations.set(evidence, selected)
      async function checkStaging(tx: StoreTransaction, requireWitness = false) {
        assert()
        store.assertWriteTransaction(tx)
        if (Storage.current().transaction !== tx || !Storage.inWriteTransaction())
          throw new StorageConflictError("Artifact staging requires its actual native write transaction")
        if ((await tx.queryKeys({ prefix: [stagingRoot], limit: 1 })).length)
          throw new StorageIntegrityError("Unknown checkpoint artifact staging records")
        let after: string[] | undefined
        using wanted = database.query<{ sha256: string; size: number; location: string | null }, [string]>(
          "SELECT sha256,size,location FROM selected WHERE staged=?",
        )
        for (;;) {
          const page = await tx.artifactPage({ prefix: [stagingRoot], after, limit: 128 })
          for (const entry of page) {
            const row = wanted.get(JSON.stringify(entry.key))
            if (
              !row ||
              row.sha256 !== entry.location.sha256 ||
              row.size !== entry.location.size ||
              ((requireWitness || row.location !== null) &&
                row.location !== JSON.stringify(ArtifactLocation.parse(entry.location)))
            )
              throw new StorageIntegrityError("Unknown checkpoint artifact staging reference")
          }
          if (page.length < 128) break
          after = page.at(-1)?.key
        }
      }
      let inspected = false
      await input.transaction(async (tx) => {
        await Storage.transaction(async () => {}, {
          commitGuard: () => {
            assert()
            if (!inspected) throw new StorageConflictError("Artifact staging inspection did not complete")
          },
        })
        await checkStaging(tx)
        inspected = true
      })
      if (!inspected)
        throw new StorageConflictError("Artifact staging requires its actual native inspection transaction")
      using page = database.query<{ key: string; staged: string; sha256: string; size: number }, [string]>(
        "SELECT key,staged,sha256,size FROM selected WHERE key>? ORDER BY key LIMIT 128",
      )
      using witness = database.query("UPDATE selected SET location=? WHERE staged=?")
      let after = ""
      for (;;) {
        const rows = page.all(after)
        if (!rows.length) break
        for (const row of rows) {
          assert()
          const target = z.array(z.string()).parse(JSON.parse(row.staged))
          const retained = await Storage.snapshot((tx) => tx.artifact(target)).catch((error: unknown) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (retained && (retained.sha256 !== row.sha256 || retained.size !== row.size))
            throw new StorageIntegrityError("Retained artifact preparation changed its checkpoint identity")
          await HomeRestoration.verifyInstalledOwner(permit)
          assert()
          using prepared = retained
            ? undefined
            : await Storage.prepareBinaryStream(target, streamArtifact({ directory, location: row, signal }), {
                signal,
              })
          let complete = false
          await input.transaction(async (tx) => {
            await Storage.transaction(async () => {}, {
              commitGuard: () => {
                assert()
                if (!complete) throw new StorageConflictError("Artifact preparation did not complete")
              },
            })
            await checkStaging(tx)
            if (prepared) await Storage.publishPreparedBinary(prepared)
            const current = await tx.artifact(target)
            if (current.sha256 !== row.sha256 || current.size !== row.size)
              throw new StorageIntegrityError("Staged artifact changed its checkpoint identity")
            complete = true
          })
          if (!complete) throw new StorageConflictError("Artifact preparation did not retain its native transaction")
          await Storage.withArtifactCheckpoint(
            async (checkpoint) => {
              const before = await Storage.snapshot((tx) => tx.artifact(target))
              if (before.size !== row.size || before.sha256 !== row.sha256)
                throw new StorageIntegrityError("Prepared artifact changed before its native stream")
              const digest = createHash("sha256")
              let bytes = 0
              for await (const chunk of checkpoint.stream(before)) {
                assert()
                bytes += chunk.length
                digest.update(chunk)
              }
              const after = await Storage.snapshot((tx) => tx.artifact(target))
              const location = JSON.stringify(ArtifactLocation.parse(before))
              if (
                bytes !== row.size ||
                digest.digest("hex") !== row.sha256 ||
                location !== JSON.stringify(ArtifactLocation.parse(after))
              )
                throw new StorageIntegrityError("Retained prepared bytes differ from their complete checkpoint")
              witness.run(location, row.staged)
            },
            { signal },
          )
          after = row.key
        }
      }
      const result = await body(evidence)
      assert()
      return result
    } finally {
      open = false
      database.close()
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
  async function artifactPublication(evidence: PreparedArtifacts, tx: StoreTransaction) {
    const selected = preparation(evidence)
    const store = Storage.current().store
    store.assertWriteTransaction(tx)
    if (Storage.current().transaction !== tx || !Storage.inWriteTransaction())
      throw new StorageConflictError("Artifact aliases require their original native write transaction")
    const existing = artifactPublications.get(tx)
    if (existing && (existing.preparation !== selected || existing.failed))
      throw new StorageConflictError("Artifact publication changed its native preparation")
    const state = existing ?? { preparation: selected, complete: false, failed: false }
    artifactPublications.set(tx, state)
    await Storage.transaction(async () => {}, {
      commitGuard: () => {
        selected.assert()
        if (!state.complete || state.failed)
          throw new StorageConflictError("Prepared artifact alias publication did not complete")
      },
    })
    return state
  }
  export async function guardPreparedArtifacts(evidence: PreparedArtifacts, tx: StoreTransaction): Promise<void> {
    await artifactPublication(evidence, tx)
  }
  export async function publishPreparedArtifacts(evidence: PreparedArtifacts, tx: StoreTransaction) {
    const state = await artifactPublication(evidence, tx)
    const selected = state.preparation
    if (state.complete) return
    try {
      await selected.checkStaging(tx)
      using page = selected.database.query<{ key: string; staged: string; location: string | null }, [string]>(
        "SELECT key,staged,location FROM selected WHERE key>? ORDER BY key LIMIT 128",
      )
      let after = ""
      for (;;) {
        const rows = page.all(after)
        if (!rows.length) break
        for (const row of rows) {
          selected.assert()
          const key = z.array(z.string()).parse(JSON.parse(row.key))
          const staged = z.array(z.string()).parse(JSON.parse(row.staged))
          const source = await tx.artifact(staged).catch((error: unknown) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (!row.location || (source && JSON.stringify(ArtifactLocation.parse(source)) !== row.location))
            throw new StorageIntegrityError("Prepared artifact alias changed its native identity")
          const existing = await tx.artifact(key).catch((error: unknown) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (existing && JSON.stringify(ArtifactLocation.parse(existing)) !== row.location)
            throw new StorageIntegrityError("Prepared artifact alias conflicts with existing target bytes")
          if (!existing && !source) throw new StorageIntegrityError("Prepared artifact alias is incomplete")
          if (!existing) await Storage.publishBinaryReference(staged, key)
          if (JSON.stringify(ArtifactLocation.parse(await tx.artifact(key))) !== row.location)
            throw new StorageIntegrityError("Published artifact alias differs from its verified native witness")
          after = row.key
        }
      }
      await selected.checkStaging(tx)
      await tx.removeTree(selected.prefix)
      if (
        (await tx.artifactPage({ prefix: [stagingRoot], limit: 1 })).length ||
        (await tx.queryKeys({ prefix: [stagingRoot], limit: 1 })).length
      )
        throw new StorageIntegrityError("Unknown checkpoint staging survived alias publication")
      tx.addMutationGuard(async (keys, tree) => {
        using original = selected.database.query<{ key: string }, [string, string]>(
          "SELECT key FROM selected WHERE key=? OR staged=?",
        )
        for (const key of keys) {
          const text = JSON.stringify(key)
          const prefix = text.slice(0, -1) + ","
          using children = selected.database.query<{ key: string }, [string, string]>(
            "SELECT key FROM selected WHERE key>=? AND key<? LIMIT 1",
          )
          if (
            original.get(text, text) ||
            key[0] === stagingRoot ||
            (tree && (key.length === 0 || children.get(prefix, prefix + "\uffff")))
          ) {
            state.failed = true
            throw new StorageConflictError("Artifact aliases changed after final native publication")
          }
        }
      })
      state.complete = true
    } catch (error) {
      state.failed = true
      throw error
    }
  }

  export async function restoreArchive(input: {
    directory: string
    keys: VaultKeyProvider
    restoreID: string
    expected?: Manifest
    signal?: AbortSignal
    commitGuard?: () => void
    base?: StorageBootstrapBase.Evidence
    finalize(tx: StoreTransaction, evidence: ImportEvidence): Promise<void>
  }) {
    const base = input.base
    const restoreID = ID.parse(input.restoreID)
    const expected = input.expected ? Manifest.parse(input.expected) : undefined
    const directory = input.directory
    const signal = input.signal
    const finalize = input.finalize
    const guard = input.commitGuard
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const configuration = JSON.stringify(store.options)
    const artifacts = handle.artifactDirectory
    const objects = handle.artifactObjects
    const objectConfiguration = objects ? { ...objects } : undefined
    const nativeGuards: Array<() => void> = []
    const assertOwner = () => {
      signal?.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== configuration ||
        current.artifactDirectory !== artifacts ||
        current.artifactObjects !== objects ||
        objects?.blobs !== objectConfiguration?.blobs ||
        objects?.writerID !== objectConfiguration?.writerID ||
        objects?.now !== objectConfiguration?.now
      )
        throw new StorageIntegrityError("Checkpoint restoration belongs to another native namespace")
    }
    const commitGuard = () => {
      assertOwner()
      if (base) StorageBootstrapBase.assert(base)
      guard?.()
      for (const nativeGuard of nativeGuards) nativeGuard()
      assertOwner()
    }
    assertOwner()
    const root = await fs.realpath(directory)
    const manifest = await verifyArchive({ directory: root, expected, keys, signal })
    assertOwner()
    const operationID = `storage-checkpoint:${restoreID}`
    const previous = await store.operationReceipt(operationID)
    assertOwner()
    if (previous) {
      if (previous.requestHash !== manifest.records.sha256)
        throw new StorageConflictError("Restore identity belongs to a different checkpoint")
      return manifest
    }
    const prefix = [stagingRoot, restoreID]
    const owns = (key: string[]) => prefix.every((part, index) => key[index] === part)
    const receiptKey = (operationID: string) => [...prefix, "preparation-receipts", sha256(operationID)]
    async function assertEmpty(tx: StoreTransaction) {
      let after: string[] | undefined
      for (;;) {
        const page = await tx.queryKeys({ prefix: [], after, limit: 128 })
        for (const key of page)
          if (!owns(key) && !physical(key[0]) && !(base && StorageBootstrapBase.contains(base, key)))
            throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
        if (page.length < 128) break
        after = page.at(-1)
      }
      for await (const entry of tx.artifacts())
        if (!owns(entry.key))
          throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
      for await (const entry of tx.exportEntries()) {
        if (
          base &&
          entry.type === "record" &&
          StorageBootstrapBase.contains(base, entry.key) &&
          !StorageBootstrapBase.accepts(base, entry)
        )
          throw new StorageConflictError("Checkpoint restoration target base changed")
        if (entry.type === "event")
          throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
        if (entry.type !== "receipt") continue
        const [value] = await tx.readMany([receiptKey(entry.operationID)])
        const evidence = PreparationReceipt.safeParse(value)
        if (
          !evidence.success ||
          evidence.data.operationID !== entry.operationID ||
          evidence.data.requestHash !== entry.requestHash ||
          evidence.data.result !== entry.result
        )
          throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
      }
    }
    await store.snapshot(assertEmpty)
    assertOwner()
    const target = (key: string[]) => [...prefix, sha256(JSON.stringify(key))]
    for await (const stored of StoragePortable.entries(path.join(root, "records.ndjson"))) {
      assertOwner()
      const entry = await recoveryEntry(root, manifest, stored, keys)
      assertOwner()
      if (entry.type !== "artifact") continue
      const filename = (
        await checkedFile(root, "objects", `${entry.location.sha256}.bin`, {
          bytes: entry.location.size,
          sha256: entry.location.sha256,
        })
      ).filename
      using prepared = await Storage.prepareBinaryStream(target(entry.key), Bun.file(filename).stream(), {
        signal,
      })
      const receipt = await Storage.preparedBinaryReceipt(prepared)
      await Storage.transaction(async (tx) => {
        await Storage.publishPreparedBinary(prepared)
        if (receipt) await tx.write(receiptKey(receipt.operationID), PreparationReceipt.parse(receipt))
      })
    }
    await StoragePortable.importFile(store, path.join(root, "records.ndjson"), {
      operationID,
      expectedSHA256: manifest.records.sha256,
      async beforeImport(tx) {
        nativeGuards.length = 0
        await assertEmpty(tx)
        if (base) nativeGuards.push(await StorageBootstrapBase.protect(base, tx))
      },
      async transform(stored, tx) {
        assertOwner()
        const entry = await recoveryEntry(root, manifest, stored, keys)
        assertOwner()
        if (entry.type !== "artifact") return entry
        const location = await tx.artifact(target(entry.key))
        if (location.size !== entry.location.size || location.sha256 !== entry.location.sha256)
          throw new StorageIntegrityError("Prepared restore bytes do not match their checkpoint reference")
        return { ...entry, location }
      },
      accept: (entry) =>
        entry.type !== "record" ||
        (!physical(entry.key[0]) && !(base && bootstrapPhysicalRecordRoots.has(entry.key[0]))),
      commitGuard,
      async afterImport(tx) {
        assertOwner()
        store.assertWriteTransaction(tx)
        let open = true
        const evidence: ImportEvidence = Object.freeze({ kind: "storage-checkpoint-import", restoreID })
        const captured = Manifest.parse(manifest)
        const proof = Object.freeze({ ...captured, records: Object.freeze({ ...captured.records }) })
        imported.set(evidence, {
          manifest: proof,
          guards: nativeGuards,
          assert(selected) {
            assertOwner()
            if (!open || selected !== tx)
              throw new StorageIntegrityError("Checkpoint import callback is closed or belongs to another transaction")
            store.assertWriteTransaction(selected)
          },
        })
        try {
          await finalize(tx, evidence)
        } finally {
          open = false
        }
        assertOwner()
        await tx.removeTree(prefix)
      },
    })
    return manifest
  }
}

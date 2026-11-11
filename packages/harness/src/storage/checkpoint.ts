import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Storage } from "./storage"
import { StoragePortable, StorageEntry } from "./portable"
import { StorageConflictError, StorageIntegrityError } from "./errors"
import { fileDigest } from "./file-digest"
import { SecretEnvelope, type VaultKeyProvider } from "../secrets/encrypted-store"
import type { StoreTransaction } from "./transactional-store"

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
  return { filename, bytes: info.size }
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

  export async function restoreArchive(input: {
    directory: string
    keys: VaultKeyProvider
    restoreID: string
    signal?: AbortSignal
    finalize(tx: StoreTransaction): Promise<void>
  }) {
    ID.parse(input.restoreID)
    const root = await fs.realpath(input.directory)
    const manifest = await verifyArchive(input)
    const operationID = `storage-checkpoint:${input.restoreID}`
    const store = Storage.current().store
    const previous = await store.operationReceipt(operationID)
    if (previous) {
      if (previous.requestHash !== manifest.records.sha256)
        throw new StorageConflictError("Restore identity belongs to a different checkpoint")
      return manifest
    }
    const prefix = [stagingRoot, input.restoreID]
    const owns = (key: string[]) => prefix.every((part, index) => key[index] === part)
    const receiptKey = (operationID: string) => [...prefix, "preparation-receipts", sha256(operationID)]
    async function assertEmpty(tx: StoreTransaction) {
      let after: string[] | undefined
      for (;;) {
        const page = await tx.queryKeys({ prefix: [], after, limit: 128 })
        for (const key of page)
          if (!owns(key) && !physical(key[0]))
            throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
        if (page.length < 128) break
        after = page.at(-1)
      }
      for await (const entry of tx.artifacts())
        if (!owns(entry.key))
          throw new StorageConflictError("Checkpoint restoration requires an independent empty namespace")
      for await (const entry of tx.exportEntries()) {
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
    const target = (key: string[]) => [...prefix, sha256(JSON.stringify(key))]
    for await (const stored of StoragePortable.entries(path.join(root, "records.ndjson"))) {
      input.signal?.throwIfAborted()
      const entry = await recoveryEntry(root, manifest, stored, input.keys)
      if (entry.type !== "artifact") continue
      const filename = (
        await checkedFile(root, "objects", `${entry.location.sha256}.bin`, {
          bytes: entry.location.size,
          sha256: entry.location.sha256,
        })
      ).filename
      using prepared = await Storage.prepareBinaryStream(target(entry.key), Bun.file(filename).stream(), {
        signal: input.signal,
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
      beforeImport: assertEmpty,
      async transform(stored, tx) {
        input.signal?.throwIfAborted()
        const entry = await recoveryEntry(root, manifest, stored, input.keys)
        if (entry.type !== "artifact") return entry
        const location = await tx.artifact(target(entry.key))
        if (location.size !== entry.location.size || location.sha256 !== entry.location.sha256)
          throw new StorageIntegrityError("Prepared restore bytes do not match their checkpoint reference")
        return { ...entry, location }
      },
      accept: (entry) => entry.type !== "record" || !physical(entry.key[0]),
      async afterImport(tx) {
        await input.finalize(tx)
        await tx.removeTree(prefix)
      },
    })
    return manifest
  }
}

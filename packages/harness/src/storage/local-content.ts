import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "./storage"
import { StoragePath } from "./path"
import { ArtifactPack } from "./artifact-pack"
import { StorageIntegrityError } from "./errors"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { storedAssets } from "../asset/stored-assets"
import { StoredToolOutput } from "../tool/stored-output"
import { encryptedSecretVault, type VaultKeyProvider } from "../secrets/encrypted-store"
import { SecretVault } from "../secrets/vault"
import { SnapshotStore } from "../session/snapshot-store"
import { SnapshotRecords } from "../session/snapshot-records"
import { SnapshotGit } from "../session/snapshot-git"
import { storedSnapshots } from "../session/stored-snapshots"

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const Source = z.union([
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("config"), path: z.string().optional() }),
  z.strictObject({ kind: z.literal("reference"), type: z.literal("env"), var: z.string() }),
  z.strictObject({ kind: z.literal("reference"), type: z.literal("file"), path: z.string() }),
  z.strictObject({ kind: z.literal("heuristic"), context: z.enum(["user_message", "tool_output", "credential_file"]) }),
])
const Vault = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(
    z.string(),
    z.strictObject({
      id: z.string(),
      value: z.string(),
      fingerprint: z.strictObject({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        length: z.number().int().nonnegative(),
      }),
      source: Source,
      policy: z
        .strictObject({
          tools: z.array(z.string()).optional(),
          maxResolvesPerSession: z.number().int().nonnegative().optional(),
        })
        .optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
      lastResolvedAt: z.number().optional(),
      resolvedCount: z.number().int().nonnegative(),
      history: z.array(
        z.strictObject({
          at: z.number(),
          sessionID: z.string().optional(),
          tool: z.string().optional(),
          outcome: z.enum(["resolved", "denied_policy", "denied_limit", "removed"]),
        }),
      ),
    }),
  ),
})

async function flatFiles(directory: string) {
  const stat = await fs.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat) return []
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== path.resolve(directory))
    throw new StorageIntegrityError("Local content directory is not a regular owned path")
  const files = (await fs.readdir(directory)).sort()
  for (const name of files) {
    const entry = await fs.lstat(path.join(directory, name))
    if (!entry.isFile() || entry.isSymbolicLink()) throw new StorageIntegrityError("Unsupported local content entry")
  }
  return files
}

/** Offline only: caller owns a verified immutable backup, a closed target writer and activation fencing. */
export async function convertLocalContent(input: {
  source: Storage.Handle
  target: Storage.Handle
  originalDataDirectory: string
  authority: readonly string[]
  keys: VaultKeyProvider
  maxEntryBytes: number
  maxEntries: number
  maxBytes: number
  signal?: AbortSignal
}) {
  if (input.source.store === input.target.store || input.source.artifactObjects || !input.target.artifactObjects)
    throw new StorageIntegrityError("Conversion needs an independent local backup and an object-backed target")
  if (
    !path.isAbsolute(input.originalDataDirectory) ||
    path.normalize(input.originalDataDirectory) !== input.originalDataDirectory ||
    input.originalDataDirectory.includes("\0") ||
    input.originalDataDirectory === path.parse(input.originalDataDirectory).root
  )
    throw new StorageIntegrityError("Historical data directory must be an exact absolute path")
  if (
    ![input.maxEntryBytes, input.maxBytes, input.maxEntries].every((n) => Number.isSafeInteger(n) && n > 0) ||
    input.maxEntryBytes > 512 * 1024 ** 2
  )
    throw new StorageIntegrityError("Invalid conversion byte limits")
  const source = <T>(body: () => T) => Storage.provide(input.source, body)
  const target = <T>(body: () => T) => Storage.provide(input.target, body)
  const result = { artifacts: 0, assets: 0, outputs: 0, snapshots: 0, secrets: 0, bytes: 0 }
  let entries = 0
  const budget = (size: number, snapshot = false) => {
    input.signal?.throwIfAborted()
    if (
      ++entries > input.maxEntries ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (!snapshot && size > input.maxEntryBytes) ||
      result.bytes + size > input.maxBytes
    )
      throw new StorageIntegrityError("Local content exceeds conversion limits")
    result.bytes += size
  }
  const readFile = async (filename: string) => {
    const stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(filename)) !== path.resolve(filename))
      throw new StorageIntegrityError("Local content file is not regular")
    budget(stat.size)
    const bytes = await fs.readFile(filename)
    if (bytes.length !== stat.size) throw new StorageIntegrityError("Local content changed during conversion")
    return bytes
  }
  const assets = storedAssets()
  const snapshots = storedSnapshots({ maxBytes: input.maxBytes })

  // Read preserved locations directly; a nested source snapshot would wait on its own reader.
  const localArtifacts = new ArtifactPack(path.join(input.source.artifactDirectory, "agent-artifacts"))
  await input.source.store.snapshot(async (tx) => {
    for await (const entry of tx.artifacts()) {
      budget(entry.location.size)
      const bytes = await localArtifacts.read(entry.location, input.maxEntryBytes)
      await target(async () => {
        await Storage.writeBinary(entry.key, bytes)
        if (sha256(await Storage.readBinary(entry.key, { maxBytes: bytes.length })) !== entry.location.sha256)
          throw new StorageIntegrityError("Converted artifact verification failed")
      })
      result.artifacts++
    }
  })
  for (const id of await flatFiles(path.join(input.source.artifactDirectory, "assets"))) {
    if (!AssetReference.isValidId(id)) throw new StorageIntegrityError("Unsupported historical asset identity")
    const bytes = await readFile(path.join(input.source.artifactDirectory, "assets", id))
    await target(async () => {
      await assets.write(id, bytes)
      const restored = await assets.read(id)
      if (!restored || sha256(restored) !== sha256(bytes))
        throw new StorageIntegrityError("Converted asset verification failed")
    })
    result.assets++
  }
  for (const id of await flatFiles(path.join(input.source.artifactDirectory, "tool-output"))) {
    const bytes = await readFile(path.join(input.source.artifactDirectory, "tool-output", id))
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const alias = path.join(input.originalDataDirectory, "tool-output", id)
    await target(async () => {
      await StoredToolOutput.save(id, text, [alias])
      const hash = createHash("sha256")
      let offset = 0
      do {
        const part = await StoredToolOutput.read({ reference: alias, offset, limit: 50 * 1024 })
        hash.update(part.text)
        offset = part.nextOffset
        if (!part.truncated) break
      } while (offset < bytes.length)
      if (hash.digest("hex") !== sha256(bytes)) throw new StorageIntegrityError("Converted output verification failed")
    })
    result.outputs++
  }
  const vaultFile = path.join(input.source.artifactDirectory, "auth", "secret-vault.json")
  const exists = await fs.lstat(vaultFile).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (exists) {
    const vault = Vault.parse(JSON.parse((await readFile(vaultFile)).toString("utf8")))
    for (const [id, entry] of Object.entries(vault.entries)) {
      if (
        id !== entry.id ||
        id !== SecretVault.idOf(entry.value) ||
        entry.fingerprint.sha256 !== sha256(entry.value) ||
        entry.fingerprint.length !== entry.value.length
      )
        throw new StorageIntegrityError("Historical vault fingerprint or identity is invalid")
    }
    await target(async () => {
      const persistence = encryptedSecretVault({ authority: input.authority, keys: input.keys })
      const previous = await persistence.read()
      if (Object.keys(previous.entries).length && JSON.stringify(Vault.parse(previous)) !== JSON.stringify(vault))
        throw new StorageIntegrityError("Encrypted target differs from the preserved vault")
      if (!Object.keys(previous.entries).length && Object.keys(vault.entries).length)
        await persistence.mutate((value) => {
          value.entries = structuredClone(vault.entries)
        })
      if (JSON.stringify(Vault.parse(await persistence.read())) !== JSON.stringify(vault))
        throw new StorageIntegrityError("Converted vault verification failed")
    })
    result.secrets = Object.keys(vault.entries).length
  }

  const scopes = await source(() => Storage.scan(["sessions"]))
  for (const scopeID of scopes) {
    const sessions = await source(() => Storage.scan(["sessions", scopeID]))
    for (const sessionID of sessions) {
      input.signal?.throwIfAborted()
      const roots = await source(() => SnapshotRecords.historicalRoots(scopeID, sessionID))
      const owner = await source(() => SnapshotStore.owner(scopeID, sessionID))
      if (owner?.backend === "deleted") continue
      if (!roots.length) {
        if (owner?.backend === "legacy")
          await target(() =>
            Storage.write(StoragePath.snapshotOwner(scopeID, sessionID), { version: 2, backend: "shared" }),
          )
        continue
      }
      if (!owner) throw new StorageIntegrityError("Historical snapshots have no owner")
      const repository = await source(() =>
        owner.backend === "legacy"
          ? SnapshotStore.legacyRepository(scopeID, sessionID)
          : SnapshotStore.repository(scopeID),
      )
      if (await Bun.file(path.join(repository, "objects/info/alternates")).exists())
        throw new StorageIntegrityError("Snapshot backup has an external dependency")
      const owned = await source(() => SnapshotStore.ownsMany(scopeID, sessionID, roots))
      if (owned.size !== roots.length) throw new StorageIntegrityError("Historical snapshot is not retained")
      for (const root of roots) {
        await target(async () => {
          await snapshots.retain(scopeID, sessionID, root, repository, input.signal)
          const manifest = await Storage.read<{ packs: Array<{ chunks: Array<{ bytes: number }> }> }>([
            "sessions",
            scopeID,
            sessionID,
            "snapshot_content",
            root,
            "manifest",
          ])
          budget(
            manifest.packs.reduce((n, pack) => n + pack.chunks.reduce((m, chunk) => m + chunk.bytes, 0), 0),
            true,
          )
          const parent = path.join(input.target.artifactDirectory, "conversion-check")
          await fs.mkdir(parent, { recursive: true, mode: 0o700 })
          const directory = await fs.mkdtemp(path.join(parent, "snapshot-"))
          try {
            const restored = path.join(directory, "store.git")
            if (!(await snapshots.restore(scopeID, sessionID, [root], restored, input.signal)).has(root))
              throw new StorageIntegrityError("Snapshot content cannot be restored")
            await SnapshotGit.checked(restored, ["fsck", "--full"], { signal: input.signal })
          } finally {
            await fs.rm(directory, { recursive: true, force: true })
          }
        })
        result.snapshots++
      }
      await target(() =>
        Storage.write(StoragePath.snapshotOwner(scopeID, sessionID), { version: 2, backend: "shared" }),
      )
    }
    await target(() =>
      Storage.write(StoragePath.snapshotRepository(scopeID), {
        version: 2,
        objectFormat: "sha1",
        content: "external-v1",
      }),
    )
  }
  // References are validated against durable readers, never against the retained local backup.
  await input.source.store.snapshot(async (tx) => {
    for await (const record of tx.exportEntries()) {
      if (record.type !== "record") continue
      const visit = async (value: unknown): Promise<void> => {
        if (typeof value === "string") {
          const asset = AssetReference.parse(value)
          if (asset && !(await target(() => assets.read(asset.id))))
            throw new StorageIntegrityError("Historical asset reference has no recoverable content")
          const prefix = path.join(input.originalDataDirectory, "tool-output") + path.sep
          if (value.startsWith(prefix)) await target(() => StoredToolOutput.read({ reference: value, limit: 4 }))
        } else if (Array.isArray(value)) {
          for (const item of value) await visit(item)
        } else if (value && typeof value === "object") {
          for (const item of Object.values(value)) await visit(item)
        }
      }
      await visit(record.value)
    }
  })
  return result
}

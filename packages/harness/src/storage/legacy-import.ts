import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { AtomicFile } from "./atomic-file"
import { StorageIntegrityError } from "./errors"
import { TransactionalStore } from "./transactional-store"

const recordRoots = new Set([
  "projects",
  "sessions",
  "operations",
  "session_index",
  "endpoint_session",
  "sessions_page_index",
  "session_child_index",
  "session_nav_v2",
  "session_search_v1",
  "session_search_dirty_v1",
  "session_message_order_v1",
  "permissions",
  "permission-rules",
  "shares",
  "meta",
  "agenda",
  "notes",
  "blueprint_loops",
  "superplan",
  "lattice",
  "holos",
  "synergy_link",
  "stats",
  "snapshot-v2",
  "plugin-approvals",
  "plugin-audit",
  "plugin-runtime-state",
  "plugin-incompatible",
  "registry",
])

export function legacyRecordKey(relative: string): string[] | undefined {
  if (relative === "@home/plugin.lock") return ["plugin-lock"]
  if (!relative.endsWith(".json")) return
  const key = relative.slice(0, -5).split("/")
  if (key.some((segment) => !segment || segment === "." || segment === ".."))
    throw new StorageIntegrityError("Invalid legacy record path")
  if (key[0] === "channel") {
    if (key[1] === "workspaces") return
    return key
  }
  if (key[0] === "browser" && /^sessions(?:-v\d+)?$/.test(key[1] ?? "")) return key
  if (key[0] === "push" && key[1] === "subscriptions") return key
  if (key[0] === "library" && key[1] === "stats") return key
  if (key[0] === "snapshot-v2" && (key.includes(".locks") || key.includes("leases"))) return
  return recordRoots.has(key[0]) ? key : undefined
}

export interface ImportProgress {
  stage: "backup" | "import" | "verify"
  current: number
  total: number
  bytes: number
}

interface ImportFile {
  relative: string
  hash: string
  size: number
  key?: string[]
  disposition: "backed-up" | "imported" | "retained" | "quarantined"
  error?: string
  linkTarget?: string
  retired?: boolean
}

interface ImportState {
  source: string
  backup: string
  backedUp: boolean
  complete: boolean
  files: number
}

export interface ImportResult {
  files: number
  imported: number
  quarantined: number
  retained: number
  bytes: number
}

const stateKey = ["storage_import", "info"]

function entryKey(relative: string) {
  return ["storage_import_files", createHash("sha256").update(relative).digest("hex")]
}

async function digest(filename: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest("hex")
}

export async function* legacyFiles(
  root: string,
  segments: string[] = [],
): AsyncGenerator<{ relative: string; size: number; linkTarget?: string }> {
  const directory = await fs.opendir(path.join(root, ...segments))
  for await (const entry of directory) {
    if (entry.name === ".locks" || entry.name.startsWith(".tmp-") || entry.name.endsWith(".tmp")) continue
    if (segments.length === 0 && entry.name === "storage") continue
    const child = [...segments, entry.name]
    if (entry.isSymbolicLink()) {
      const relative = child.join("/")
      if (recordRoots.has(child[0]) || legacyRecordKey(relative))
        throw new StorageIntegrityError("Authoritative legacy records cannot be symbolic links")
      const linkTarget = await fs.readlink(path.join(root, ...child))
      yield { relative, size: Buffer.byteLength(linkTarget), linkTarget }
      continue
    }
    if (entry.isDirectory()) yield* legacyFiles(root, child)
    else if (entry.isFile()) {
      const stat = await fs.stat(path.join(root, ...child))
      yield { relative: child.join("/"), size: stat.size }
    } else throw new StorageIntegrityError("Legacy storage contains an unsupported file type")
  }
}

export async function* legacySources(
  dataRoot: string,
): AsyncGenerator<{ relative: string; size: number; linkTarget?: string }> {
  yield* legacyFiles(dataRoot)
  const config = path.join(dataRoot, "..", "config")
  try {
    for await (const entry of legacyFiles(config)) yield { ...entry, relative: `@home/config/${entry.relative}` }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
  const lock = path.join(dataRoot, "..", "plugin.lock")
  try {
    const stat = await fs.lstat(lock)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new StorageIntegrityError("Plugin installation metadata is not a regular file")
    yield { relative: "@home/plugin.lock", size: stat.size }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
}

function sourcePath(dataRoot: string, relative: string) {
  if (relative === "@home/plugin.lock") return path.join(dataRoot, "..", "plugin.lock")
  const segments = relative.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\")))
    throw new StorageIntegrityError("Unsafe migration source identity")
  return segments[0] === "@home" ? path.join(dataRoot, "..", ...segments.slice(1)) : path.join(dataRoot, ...segments)
}

async function backupFile(source: string, target: string, expectedHash: string) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await fs.copyFile(source, temporary)
    if ((await digest(temporary)) !== expectedHash)
      throw new StorageIntegrityError("Legacy data changed while its backup was being copied")
    await fs.chmod(temporary, 0o600)
    const file = await fs.open(temporary, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, target)
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(target), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export class LegacyJsonImporter {
  constructor(
    private readonly options: {
      dataRoot: string
      backupRoot: string
      store: TransactionalStore
      progress?: (progress: ImportProgress) => void
    },
  ) {}

  async run(): Promise<ImportResult> {
    const { store, dataRoot, backupRoot, progress } = this.options
    const identity = createHash("sha256")
      .update(await fs.realpath(dataRoot))
      .digest("hex")
    const [saved] = await store.readMany<ImportState>([stateKey])
    if (saved && (saved.source !== identity || saved.backup !== path.resolve(backupRoot)))
      throw new StorageIntegrityError("Migration source or backup identity changed")
    if (!saved) {
      let backupBytes = 0n
      let recordBytes = 0n
      for await (const entry of legacySources(dataRoot)) {
        backupBytes += BigInt(entry.size)
        if (legacyRecordKey(entry.relative)) recordBytes += BigInt(entry.size) + 4096n
      }
      const disk = await fs.statfs(dataRoot, { bigint: true })
      const required = backupBytes + recordBytes * 3n + 32n * 1024n * 1024n
      if (disk.bavail * disk.bsize < required)
        throw new StorageIntegrityError(
          "Insufficient free space for the immutable backup, database and migration journal; free space and resume",
        )
    }
    const state: ImportState = saved ?? {
      source: identity,
      backup: path.resolve(backupRoot),
      backedUp: false,
      complete: false,
      files: 0,
    }
    await store.write(stateKey, state)
    let count = 0
    let bytes = 0
    progress?.({ stage: "backup", current: 0, total: state.files, bytes: 0 })
    for await (const source of legacySources(dataRoot)) {
      const filename = sourcePath(dataRoot, source.relative)
      const key = entryKey(source.relative)
      const [previous] = await store.readMany<ImportFile>([key])
      const hash =
        source.linkTarget === undefined
          ? await digest(filename)
          : createHash("sha256").update(source.linkTarget).digest("hex")
      if (previous) {
        if (previous.relative !== source.relative || previous.hash !== hash)
          throw new StorageIntegrityError("Legacy data changed after the migration snapshot was recorded")
        const backup = path.join(backupRoot, "data", source.relative)
        const backupHash =
          previous.linkTarget === undefined
            ? await digest(backup)
            : createHash("sha256")
                .update(await fs.readlink(backup))
                .digest("hex")
        if (backupHash !== previous.hash) throw new StorageIntegrityError("Migration backup failed its integrity check")
      } else {
        if (state.backedUp)
          throw new StorageIntegrityError("New legacy data appeared after the migration snapshot was sealed")
        const backup = path.join(backupRoot, "data", source.relative)
        if (source.linkTarget === undefined) await backupFile(filename, backup, hash)
        else {
          await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 })
          try {
            await fs.symlink(source.linkTarget, backup)
          } catch (error) {
            if (
              !(error && typeof error === "object" && "code" in error && error.code === "EEXIST") ||
              (await fs.readlink(backup)) !== source.linkTarget
            )
              throw error
          }
        }
        const entry: ImportFile = { ...source, hash, key: legacyRecordKey(source.relative), disposition: "backed-up" }
        await store.write(key, entry)
      }
      bytes += source.size
      count++
      progress?.({ stage: "backup", current: count, total: state.files, bytes })
    }
    if (state.backedUp && count !== state.files)
      throw new StorageIntegrityError("Legacy files disappeared after the migration snapshot was sealed")
    const inventoryPath = path.join(backupRoot, "inventory.ndjson")
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 })
    const inventory = await fs.open(inventoryPath + ".tmp", "w", 0o600)
    const inventoryHash = createHash("sha256")
    try {
      let cursor: string[] | undefined
      for (;;) {
        const records = await store.query<ImportFile>({ kind: "storage_import_files", after: cursor, limit: 128 })
        if (!records.length) break
        for (const { value } of records) {
          const line =
            JSON.stringify({
              relative: value.relative,
              hash: value.hash,
              size: value.size,
              linkTarget: value.linkTarget,
              key: value.key,
            }) + "\n"
          inventoryHash.update(line)
          await inventory.writeFile(line)
        }
        cursor = records.at(-1)!.key
      }
      await inventory.sync()
    } finally {
      await inventory.close()
    }
    await fs.rename(inventoryPath + ".tmp", inventoryPath)
    state.backedUp = true
    state.files = count
    await store.write(stateKey, state)
    await AtomicFile.writeJsonAtomic(
      path.join(backupRoot, "manifest.json"),
      JSON.stringify({
        version: 1,
        source: identity,
        files: count,
        bytes,
        inventorySHA256: inventoryHash.digest("hex"),
      }),
      { private: true, durable: true },
    )

    const result: ImportResult = { files: count, bytes, imported: 0, quarantined: 0, retained: 0 }
    let after: string[] | undefined
    progress?.({ stage: "import", current: 0, total: count, bytes: 0 })
    let importedBytes = 0
    for (;;) {
      const batch = await store.query<ImportFile>({ kind: "storage_import_files", after, limit: 128 })
      if (!batch.length) break
      for (const record of batch) {
        const entry = record.value
        if (entry.disposition === "backed-up") await this.import(record.key, entry)
        if (entry.disposition === "quarantined" && ["projects", "meta"].includes(entry.key?.[0] ?? ""))
          throw new StorageIntegrityError(
            "A global identity or migration ledger is corrupt; restore and repair a copy of the pre-upgrade backup before retrying",
          )
        if (entry.disposition === "imported") result.imported++
        else if (entry.disposition === "quarantined") result.quarantined++
        else result.retained++
        importedBytes += entry.size
        progress?.({
          stage: "import",
          current: result.imported + result.quarantined + result.retained,
          total: count,
          bytes: importedBytes,
        })
      }
      after = batch.at(-1)!.key
    }
    progress?.({ stage: "verify", current: 0, total: count, bytes: 0 })
    if (result.imported + result.quarantined + result.retained !== count)
      throw new StorageIntegrityError("Migration did not account for every source file")
    state.complete = true
    await store.write(stateKey, state)
    progress?.({ stage: "verify", current: count, total: count, bytes })
    return result
  }

  async retire(): Promise<void> {
    const { store, dataRoot, backupRoot } = this.options
    let after: string[] | undefined
    for (;;) {
      const batch = await store.query<ImportFile>({ kind: "storage_import_files", after, limit: 128 })
      if (!batch.length) return
      for (const record of batch) {
        const entry = record.value
        if (!entry.key || entry.retired) continue
        if (entry.disposition !== "imported" && entry.disposition !== "quarantined")
          throw new StorageIntegrityError("Cannot retire an unaccounted legacy record")
        if ((await digest(path.join(backupRoot, "data", entry.relative))) !== entry.hash)
          throw new StorageIntegrityError("Cannot retire a legacy record whose backup is invalid")
        const source = sourcePath(dataRoot, entry.relative)
        try {
          if ((await digest(source)) !== entry.hash)
            throw new StorageIntegrityError("A legacy writer changed data during activation")
          await fs.unlink(source)
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
        }
        entry.retired = true
        await store.write(record.key, entry)
      }
      after = batch.at(-1)!.key
    }
  }

  private async import(recordKey: string[], entry: ImportFile) {
    const { store, backupRoot } = this.options
    if (!entry.key) {
      entry.disposition = "retained"
      await store.write(recordKey, entry)
      return
    }
    let value: unknown
    try {
      value = JSON.parse(await fs.readFile(path.join(backupRoot, "data", entry.relative), "utf8"))
      if (
        entry.key[0] === "projects" &&
        (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value) || value.id !== entry.key[1])
      )
        throw new StorageIntegrityError("Legacy Scope identity does not match its key")
      if (
        entry.key[0] === "meta" &&
        entry.key[1] === "migration" &&
        (!value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some((timestamp) => typeof timestamp !== "number" || !Number.isFinite(timestamp)))
      )
        throw new StorageIntegrityError("Legacy migration ledger is malformed")
      if (entry.key[0] === "sessions" && (entry.key[3] === "info" || entry.key[3] === "messages")) {
        const expectedID = entry.key.at(-1) === "info" ? entry.key.at(-2) : entry.key.at(-1)
        if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value) || value.id !== expectedID)
          throw new StorageIntegrityError("Legacy record identity does not match its owner")
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof StorageIntegrityError)) throw error
      entry.disposition = "quarantined"
      entry.error = error instanceof SyntaxError ? "Invalid JSON" : "Invalid record identity"
      await store.transaction(async (tx) => {
        await tx.write(recordKey, entry)
        if (entry.key?.[0] === "sessions" && entry.key[2]) {
          await tx.write(["storage_recovery", "sessions", entry.key[2], "info"], {
            blocked: true,
            reason: "historical_data_gap",
            scopeID: entry.key[1],
          })
          await tx.write(["storage_recovery", "sessions", entry.key[2], "issues", recordKey.at(-1)!], {
            source: entry.relative,
            error: entry.error,
          })
        } else
          await tx.write(["storage_recovery", "records", recordKey.at(-1)!], {
            key: entry.key,
            source: entry.relative,
            error: entry.error,
          })
      })
      return
    }
    await store.transaction(async (tx) => {
      const [existing] = await tx.readMany([entry.key!])
      if (existing !== undefined)
        throw new StorageIntegrityError("A legacy record conflicts with an existing target record")
      await tx.write(entry.key!, value)
      entry.disposition = "imported"
      await tx.write(recordKey, entry)
    })
  }
}

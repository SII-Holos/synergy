import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { ArtifactLocation } from "./artifact-location"
import { ArtifactPack } from "./artifact-pack"
import { PackedBackup, type PackedBackupEntry } from "./packed-backup"
import { syncRetiredDirectories, legacyBinaryKey, legacyRecordKey, legacySources, sourcePath } from "./legacy-source"
import { StorageCompat } from "./compat"
import { validateLegacyRecord } from "./legacy-record"
import { StorageIntegrityError } from "./errors"
import { fileDigest } from "./file-digest"
import type { ImportProgress, ImportResult } from "./legacy-import"
import type { TransactionalStore, StoreTransaction } from "./transactional-store"

const stateKey = ["storage_import", "info"]
const GiB = 1024 ** 3
const globalFailure =
  "A global identity or migration ledger is corrupt; restore and repair a copy of the pre-upgrade backup before retrying"
type Result = ImportResult & { artifacts: number; deferred?: number }
interface State {
  version: 2
  source: string
  backup: string
  phase: "backup" | "owners" | "import" | "complete" | "retiring" | "retired"
  cursor: number
  files: number
  backupUpperBytes: number
  databaseBudgetBytes: number
  reserveBytes: number
  journalBudgetBytes: number
  migrationBudgetBytes: number
  result: Result
  fatal?: boolean
}
type Prepared = {
  entry: PackedBackupEntry
  key?: string[]
  value?: unknown
  error?: string
  binary?: { key: string[]; location: ArtifactLocation }
  position: number
  deferred?: boolean
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
function isOwner(key?: string[]) {
  return key?.length === 4 && key[0] === "sessions" && key[3] === "info"
}

export class PackedLegacyImporter {
  constructor(
    private readonly options: {
      dataRoot: string
      backupRoot: string
      store: TransactionalStore
      progress?: (value: ImportProgress) => void
      deferSessions?: boolean
    },
  ) {}

  private deferred(relative: string) {
    return this.options.deferSessions === true && StorageCompat.deferRelative(relative)
  }

  private async capacity(required: number) {
    const disk = await fs.statfs(this.options.dataRoot, { bigint: true })
    if (disk.bavail * disk.bsize < BigInt(Math.ceil(required)))
      throw new StorageIntegrityError(
        "Insufficient free space for the remaining migration phase and recovery reserve; free space and resume",
      )
  }

  private async initial(): Promise<State> {
    const { dataRoot, backupRoot, store, progress } = this.options
    const source = hash(await fs.realpath(dataRoot))
    const [saved] = await store.readMany<State>([stateKey])
    if (saved) {
      if (saved.version !== 2 || saved.source !== source || saved.backup !== path.resolve(backupRoot))
        throw new StorageIntegrityError("Migration format, source or backup identity changed")
      return saved
    }
    let bytes = 0,
      files = 0,
      records = 0,
      recordBytes = 0,
      artifacts = 0,
      metadataBytes = 0,
      largeFiles = 0,
      portableBytes = 0
    progress?.({ stage: "scan", current: 0, total: 0, bytes: 0 })
    for await (const entry of legacySources(dataRoot)) {
      files++
      bytes += entry.size
      metadataBytes +=
        Buffer.byteLength(JSON.stringify({ ...entry, hash: "0".repeat(64), codec: "gzip", storedBytes: entry.size })) +
        16
      if (entry.size > 2 * 1024 ** 2) largeFiles++
      if (entry.relative === "agent-records.ndjson") portableBytes += entry.size
      if (legacyRecordKey(entry.relative)) {
        records++
        recordBytes += entry.size
      }
      if (legacyBinaryKey(entry.relative)) artifacts++
      if (files % 256 === 0) progress?.({ stage: "scan", current: files, total: 0, bytes })
    }
    progress?.({ stage: "scan", current: files, total: files, bytes })
    const groups = Math.ceil((bytes + metadataBytes) / 1024 ** 2) + Math.ceil(files / 1024) + 2 * largeFiles + 1
    const backupUpperBytes = Math.ceil((bytes + metadataBytes) * 1.002) + groups * 16_384
    const databaseBudgetBytes = recordBytes + records * 3072 + artifacts * 1024 + portableBytes * 2
    const reserveBytes = Math.min(20 * GiB, Math.max(32 * 1024 ** 2, databaseBudgetBytes * 0.5))
    const journalBudgetBytes = Math.min(8 * GiB, Math.max(32 * 1024 ** 2, databaseBudgetBytes * 0.15))
    const migrationBudgetBytes = Math.min(5 * GiB, Math.max(32 * 1024 ** 2, databaseBudgetBytes * 0.1))
    await this.capacity(
      backupUpperBytes + databaseBudgetBytes + reserveBytes + journalBudgetBytes + migrationBudgetBytes,
    )
    const state: State = {
      version: 2,
      source,
      backup: path.resolve(backupRoot),
      phase: "backup",
      cursor: 0,
      files,
      backupUpperBytes,
      databaseBudgetBytes,
      reserveBytes,
      journalBudgetBytes,
      migrationBudgetBytes,
      result: { files, bytes, imported: 0, retained: 0, quarantined: 0, artifacts: 0, deferred: 0 },
    }
    await store.write(stateKey, state)
    return state
  }

  async run(): Promise<Result> {
    const { store, dataRoot, backupRoot, progress } = this.options
    let state = await this.initial()
    if (state.phase === "retiring" || state.phase === "retired")
      throw new StorageIntegrityError("The import has entered activation; resume retirement")
    const backup = new PackedBackup({
      dataRoot,
      backupRoot,
      capacity: (bytes) => this.capacity(state.reserveBytes + bytes),
      progress: (value) =>
        progress?.({ stage: "backup", current: value.files, total: state.files, bytes: value.bytes }),
    })
    progress?.({ stage: "backup", current: 0, total: state.files, bytes: 0 })
    const manifest = await backup.create()
    if (manifest.files !== state.files || manifest.bytes !== state.result.bytes)
      throw new StorageIntegrityError("Legacy data changed after the migration inventory")
    progress?.({ stage: "inventory", current: 0, total: state.files, bytes: 0 })
    progress?.({ stage: "inventory", current: manifest.files, total: manifest.files, bytes: manifest.storedBytes })
    if (state.fatal) throw new StorageIntegrityError(globalFailure)
    if (state.phase === "complete") {
      if (
        state.result.imported + state.result.quarantined + state.result.retained + (state.result.deferred ?? 0) !==
        state.files
      )
        throw new StorageIntegrityError("Migration did not account for every source file")
      return state.result
    }
    if (state.phase === "backup") {
      await this.capacity(
        state.databaseBudgetBytes + state.reserveBytes + state.journalBudgetBytes + state.migrationBudgetBytes,
      )
      state = { ...state, phase: "owners", cursor: 0 }
      await store.write(stateKey, state)
    }
    const pack = new ArtifactPack(path.join(dataRoot, "agent-artifacts"))
    for (const phase of ["owners", "import"] as const) {
      if (state.phase !== phase) continue
      progress?.({ stage: phase, current: state.cursor, total: state.files, bytes: 0 })
      let position = 0
      let batch: Prepared[] = []
      let adopted: { group: number; pack: string } | undefined
      const flush = async () => {
        if (!batch.length) return
        await this.capacity(state.reserveBytes)
        const prepared = batch
        state = await store.transaction(async (tx) => {
          const next = { ...state, result: { ...state.result }, cursor: prepared.at(-1)!.position }
          const records: Array<{ key: string[]; value: unknown }> = []
          const binaries: Array<{ key: string[]; location: ArtifactLocation }> = []
          const candidates = prepared.filter(
            (item) => item.key && !item.deferred && (phase !== "owners" || isOwner(item.key)),
          )
          const existing = await tx.readMany(candidates.map((item) => item.key!))
          const ownerKeys = new Map<string, string[]>()
          if (phase === "import")
            for (const item of prepared) {
              if (item.deferred) continue
              const key = item.key ?? item.binary?.key
              if (key?.[0] === "sessions" && key.length > 4) ownerKeys.set(key[2], key.slice(0, 3))
            }
          const owners = [...ownerKeys.entries()]
          const ownerValues = await tx.readMany(
            owners.flatMap(([id, key]) => [
              [...key, "info"],
              ["storage_recovery", "sessions", id, "info"],
            ]),
          )
          const blocked = new Set(
            owners
              .filter((_, index) => ownerValues[index * 2] === undefined && ownerValues[index * 2 + 1] !== undefined)
              .map(([id]) => id),
          )
          let candidateIndex = 0
          for (const item of prepared) {
            const { key, entry } = item
            if (item.deferred) {
              if (phase === "import") next.result.deferred = (next.result.deferred ?? 0) + 1
              continue
            }
            if (phase === "owners" && !isOwner(key)) continue
            const before = key ? existing[candidateIndex++] : undefined
            if (phase === "import" && isOwner(key)) {
              if (before === undefined) next.result.quarantined++
              else next.result.imported++
              continue
            }
            const identity = key ?? item.binary?.key
            if (identity?.[0] === "sessions" && blocked.has(identity[2])) {
              next.result.quarantined++
              continue
            }
            if (item.error) {
              await this.quarantine(tx, entry, key!, item.error)
              if (phase === "import") next.result.quarantined++
              if (["projects", "meta"].includes(key![0])) next.fatal = true
              continue
            }
            if (key) {
              if (before !== undefined)
                throw new StorageIntegrityError("A legacy record conflicts with an existing target record")
              records.push({ key, value: item.value })
              if (phase === "import") next.result.imported++
            } else if (item.binary) {
              binaries.push(item.binary)
              next.result.imported++
              next.result.artifacts++
            } else next.result.retained++
          }
          await tx.writeMany(records)
          await tx.writeArtifacts(binaries)
          await tx.write(stateKey, next)
          return next
        })
        batch = []
        progress?.({ stage: phase, current: state.cursor, total: state.files, bytes: 0 })
        if (state.fatal) throw new StorageIntegrityError(globalFailure)
      }
      for await (const entry of backup.entries()) {
        position++
        if (position <= state.cursor) continue
        const key = legacyRecordKey(entry.relative)
        const deferred = this.deferred(entry.relative)
        const item: Prepared = { entry, key, position, deferred }
        if (key && !deferred && ((phase === "import" && !isOwner(key)) || (phase === "owners" && isOwner(key)))) {
          try {
            item.value = JSON.parse(
              entry.data ? entry.data.toString("utf8") : await fs.readFile(entry.filename!, "utf8"),
            ) as unknown
            validateLegacyRecord(key, item.value)
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof StorageIntegrityError)) throw error
            item.error = error instanceof SyntaxError ? "Invalid JSON" : error.message
          }
        }
        if (!deferred && phase === "import") {
          const binary = legacyBinaryKey(entry.relative)
          if (binary) {
            if (adopted?.group !== entry.group) adopted = { group: entry.group, pack: await pack.adopt(entry.packed) }
            item.binary = {
              key: binary,
              location: {
                pack: adopted.pack,
                blockOffset: entry.packed.blockOffset,
                blockBytes: entry.packed.storedBytes,
                decodedBytes: entry.packed.decodedBytes,
                offset: entry.packed.offset,
                size: entry.size,
                codec: entry.packed.codec,
                sha256: entry.hash,
              },
            }
          }
        }
        batch.push(item)
        if (batch.length === 256) await flush()
      }
      await flush()
      if (position !== state.files) throw new StorageIntegrityError("The packed inventory is incomplete")
      if (
        phase === "import" &&
        state.result.imported + state.result.quarantined + state.result.retained + (state.result.deferred ?? 0) !==
          state.files
      )
        throw new StorageIntegrityError("Migration did not account for every source file")
      state = { ...state, phase: phase === "owners" ? "import" : "complete", cursor: 0 }
      await store.write(stateKey, state)
    }
    progress?.({ stage: "verify", current: 0, total: state.files, bytes: 0 })
    if (
      state.result.imported + state.result.quarantined + state.result.retained + (state.result.deferred ?? 0) !==
      state.files
    )
      throw new StorageIntegrityError("Migration did not account for every source file")
    progress?.({ stage: "verify", current: state.files, total: state.files, bytes: state.result.bytes })
    return state.result
  }

  private async quarantine(tx: StoreTransaction, entry: PackedBackupEntry, key: string[], error: string) {
    const id = hash(entry.relative)
    if (key[0] === "sessions" && key[2]) {
      await tx.write(["storage_recovery", "sessions", key[2], "info"], {
        blocked: true,
        reason: "historical_data_gap",
        scopeID: key[1],
      })
      await tx.write(["storage_recovery", "sessions", key[2], "issues", id], { source: entry.relative, error })
    } else await tx.write(["storage_recovery", "records", id], { key, source: entry.relative, error })
  }

  async retire() {
    const { store, dataRoot, backupRoot, progress } = this.options
    let state = await this.initial()
    if (state.phase === "retired") return
    if (state.fatal || !["complete", "retiring"].includes(state.phase))
      throw new StorageIntegrityError("Cannot retire an incomplete legacy import")
    if (state.phase === "complete") {
      state = { ...state, phase: "retiring", cursor: 0 }
      await store.write(stateKey, state)
    }
    const backup = new PackedBackup({ dataRoot, backupRoot })
    let position = 0
    let committed = state.cursor
    const directories = new Set<string>()
    progress?.({ stage: "activate", current: committed, total: state.files, bytes: 0 })
    const checkpoint = async () => {
      await syncRetiredDirectories(dataRoot, directories)
      directories.clear()
      state = { ...state, cursor: position }
      await store.write(stateKey, state)
      committed = position
      progress?.({ stage: "activate", current: position, total: state.files, bytes: 0 })
    }
    for await (const entry of backup.entries()) {
      position++
      if (position <= committed) continue
      if (this.deferred(entry.relative)) continue
      if (legacyRecordKey(entry.relative) || legacyBinaryKey(entry.relative)) {
        const filename = sourcePath(dataRoot, entry.relative)
        try {
          if ((await fileDigest(filename, entry.size)) !== entry.hash)
            throw new StorageIntegrityError("A legacy writer changed data during activation")
          await fs.unlink(filename)
        } catch (error) {
          if (error instanceof StorageIntegrityError)
            throw new StorageIntegrityError("A legacy writer changed data during activation", { cause: error })
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
        }
        directories.add(path.dirname(filename))
      }
      if (position - committed >= 1024) await checkpoint()
    }
    if (position !== committed) await checkpoint()
    state = { ...state, phase: "retired" }
    await store.write(stateKey, state)
  }
}

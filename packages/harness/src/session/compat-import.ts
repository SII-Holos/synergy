import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { work } from "../util/queue"
import { UpgradeWork } from "../storage/upgrade-work"
import { SessionSegment } from "./segment-import"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { ArtifactPack } from "../storage/artifact-pack"
import type { ArtifactLocation } from "../storage/artifact-location"
import type { PackedBackupEntry } from "../storage/packed-backup"
import { SegmentedBackup } from "../storage/segmented-backup"
import { StorageCompat } from "../storage/compat"
import { SessionPreparingError, StorageIntegrityError } from "../storage/errors"
import { legacyBinaryKey, legacyFiles, legacyRecordKey, syncRetiredDirectories } from "../storage/legacy-source"
import { validateLegacyRecord } from "../storage/legacy-record"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Info } from "./types"
import type { SessionEndpoint } from "./endpoint"
import type { ScopeNavIndex } from "./nav"
import type { Session } from "."

const log = Log.create({ service: "session.compat-import" })
const inFlight = new WeakMap<object, Map<string, Promise<StorageCompat.Locator>>>()
const migrationKey = ["compat_import", "migration"]
const backups = Storage.state(() => new Map<string, SegmentedBackup>())
const foreground = Storage.state(() => ({ count: 0 }))
const maintenance = Storage.state(() => ({ failed: false, failures: 0, retryAfter: 0 }))
const preparations = Storage.state(() => new Map<string, Promise<void>>())

async function segmentedBackup() {
  const [info] = await Storage.readMany<StorageCompat.Info>([StorageCompat.infoKey])
  if (!info?.backupID) return
  const current = backups()
  let backup = current.get(info.backupID)
  if (!backup) {
    backup = new SegmentedBackup(dataRoot(), info.backupID)
    current.set(info.backupID, backup)
  }
  return backup
}

function dataRoot() {
  return Storage.current().artifactDirectory
}

function missing(error: unknown) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
}

async function digest(filename: string) {
  const hash = createHash("sha256")
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest("hex")
}

export namespace SessionCompat {
  export class BlockedError extends StorageIntegrityError {
    constructor(
      readonly sessionID: string,
      readonly source: string,
    ) {
      super(`Session ${sessionID} has quarantined historical data (${source}); inspect and repair it before continuing`)
    }
  }

  export async function isActive() {
    const [info] = await Storage.readMany<{ boundary: string }>([["compat_import", "info"]])
    return info?.boundary === StorageCompat.boundary
  }

  export async function blockedSource(sessionID: string) {
    const locator = await StorageCompat.readLocator(Storage.current().store, sessionID)
    return locator?.status === "quarantined" ? (locator.source ?? "quarantined data") : undefined
  }

  export async function ensureImported(sessionID: string, background = false): Promise<StorageCompat.Locator> {
    const priority = foreground()
    if (!background) priority.count++
    const releasePriority = background ? () => {} : UpgradeWork.priority(sessionID)
    try {
      return await importSession(sessionID, background)
    } finally {
      releasePriority()
      if (!background) priority.count--
    }
  }

  export async function drain() {
    const flights = inFlight.get(Storage.current().store)
    const jobs = preparations()
    while (flights?.size || jobs.size) await Promise.allSettled([...(flights?.values() ?? []), ...jobs.values()])
  }

  async function importSession(sessionID: string, background: boolean): Promise<StorageCompat.Locator> {
    const store = Storage.current().store
    if (Storage.inTransaction()) {
      const [locator] = await Storage.readMany<StorageCompat.Locator>([StorageCompat.locatorKey(sessionID)])
      if (!locator) return { sessionID, scopeID: "", status: "imported" }
      if (locator.status === "imported" || locator.status === "quarantined") return locator
      throw new StorageIntegrityError("Import the deferred Session before opening a business transaction")
    }
    let flights = inFlight.get(store)
    if (!flights) {
      flights = new Map()
      inFlight.set(store, flights)
    }
    const pending = flights.get(sessionID)
    if (pending) {
      try {
        return await pending
      } catch (error) {
        if (background || !(error instanceof DOMException && error.name === "AbortError")) throw error
        if (flights.get(sessionID) === pending) flights.delete(sessionID)
        return importSession(sessionID, false)
      }
    }
    const run = (async () => {
      const locator = await StorageCompat.readLocator(store, sessionID)
      if (!locator) return { sessionID, scopeID: "", status: "imported" as const }
      if (locator.status === "imported" || locator.status === "quarantined") return locator
      if ((await Storage.readMany([migrationKey]))[0]) {
        throw new StorageIntegrityError("Deferred sessions await completion of the owning domain migrations")
      }
      const task = UpgradeWork.controller(background, sessionID)
      const inherited = UpgradeWork.signal()
      const signal = inherited ? AbortSignal.any([inherited, task.controller.signal]) : task.controller.signal
      try {
        return await UpgradeWork.run({ background, sessionID, signal }, () =>
          UpgradeWork.ownerSlot(background, () => Storage.withMigrationRecords(() => importAggregate(locator))),
        )
      } finally {
        task.dispose()
      }
    })()
    flights.set(sessionID, run)
    try {
      return await run
    } finally {
      if (flights.get(sessionID) === run) flights.delete(sessionID)
    }
  }

  export async function requireImported(sessionID: string) {
    const pending = ensureImported(sessionID)
    let timer: ReturnType<typeof setTimeout> | undefined
    const locator = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SessionPreparingError({
                sessionID,
                message: "Historical Session preparation is continuing; poll preparation status before opening it",
              }),
            ),
          1500,
        )
      }),
    ]).finally(() => clearTimeout(timer))
    if (locator.status !== "imported") throw new BlockedError(sessionID, locator.source ?? "quarantined data")
    return locator
  }

  export const control = UpgradeWork.control

  export async function preparation(sessionID: string) {
    const locator = await StorageCompat.readLocator(Storage.current().store, sessionID)
    return {
      sessionID,
      state:
        !locator || locator.status === "imported"
          ? ("ready" as const)
          : locator.status === "quarantined"
            ? ("blocked" as const)
            : locator.error
              ? ("failed" as const)
              : inFlight.get(Storage.current().store)?.has(sessionID)
                ? ("preparing" as const)
                : ("pending" as const),
      phase: locator?.phase,
      files: locator?.files ?? 0,
      bytes: locator?.bytes ?? 0,
      error: locator?.error,
    }
  }

  export async function prepare(sessionID: string, retry = false) {
    const store = Storage.current().store
    const locator = await StorageCompat.readLocator(store, sessionID)
    if (!locator || locator.status === "imported" || locator.status === "quarantined" || preparations().has(sessionID))
      return preparation(sessionID)
    if (locator?.error && !retry) return preparation(sessionID)
    if (retry && locator && !inFlight.get(store)?.has(sessionID))
      await StorageCompat.writeLocator(store, { ...locator, error: undefined, retryAfter: undefined })
    const job = ensureImported(sessionID)
      .then(() => {})
      .catch(async (error) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        const current = await StorageCompat.readLocator(store, sessionID)
        if (current && current.status !== "imported")
          await StorageCompat.writeLocator(store, {
            ...current,
            error: {
              category: error instanceof StorageIntegrityError ? "integrity" : "retryable",
              message:
                error instanceof StorageIntegrityError
                  ? "Historical integrity verification failed; preserve the recovery set for repair"
                  : "Preparation failed; resolve the storage problem and retry",
            },
          })
        log.warn("foreground historical preparation failed", { sessionID, error })
      })
      .catch((error) => log.warn("failed to record historical preparation outcome", { error }))
      .finally(() => preparations().delete(sessionID))
    preparations().set(sessionID, job)
    return preparation(sessionID)
  }

  const backupStatus = Storage.state(() => ({ checkedAt: -Infinity, value: { complete: true, sealed: 0, total: 0 } }))
  export async function status() {
    const counts = await stats()
    const cached = backupStatus()
    if ((!cached.value.complete || cached.checkedAt === -Infinity) && performance.now() - cached.checkedAt > 5000) {
      const backup = await segmentedBackup()
      if (backup) {
        const value = await backup.completeness()
        cached.value = { complete: value.independent, sealed: value.sealed, total: value.total }
      }
      cached.checkedAt = performance.now()
    }
    return {
      ready: true as const,
      ...counts,
      historyReady: !counts.pending && !counts.partial && !counts.quarantined,
      backup: { ...cached.value, attention: maintenance().failed },
      ...(await UpgradeWork.status()),
    }
  }

  export async function stats() {
    const [info] = await Storage.readMany<StorageCompat.Info>([StorageCompat.infoKey])
    return info?.counts ?? { pending: 0, partial: 0, imported: 0, quarantined: 0, total: 0 }
  }

  export async function catalogPage(input: { scopeID?: string; after?: string[]; limit?: number } = {}) {
    const rows = await Storage.query<StorageCompat.Catalog>({
      kind: "compat_catalog",
      scopeID: input.scopeID,
      after: input.after,
      limit: Math.min(100, input.limit ?? 50),
      descending: true,
    })
    return {
      items: rows.map(({ value }) => ({ sessionID: value.sessionID, scopeID: value.scopeID, status: value.status })),
      next: rows.at(-1)?.key,
    }
  }

  export function pendingSessions() {
    return StorageCompat.pendingLocators(Storage.current().store)
  }

  export async function stageForMigrations(domains: string[], progress?: (current: number, total: number) => void) {
    if (!(await isActive())) return
    const [previous] = await Storage.readMany<{ domains: string[] }>([migrationKey])
    await Storage.write(migrationKey, { domains: [...new Set([...(previous?.domains ?? []), ...domains])] })
    const locators = await Storage.readMany<StorageCompat.Locator>(await Storage.list(["compat_import", "sessions"]))
    let done = 0
    progress?.(0, locators.length)
    for (const locator of locators) {
      if (!locator || locator.status === "imported") continue
      const staged = locator.status === "quarantined" ? locator : await importAggregate(locator, true)
      if (staged.status === "quarantined") throw new BlockedError(staged.sessionID, staged.source ?? "quarantined data")
      progress?.(++done, locators.length)
    }
  }

  export async function migrationsCompleted(domains: string[]) {
    const [pending] = await Storage.readMany<{ domains: string[] }>([migrationKey])
    if (!pending) return
    const remaining = pending.domains.filter((domain) => !domains.includes(domain))
    if (remaining.length) await Storage.write(migrationKey, { domains: remaining })
    else await Storage.remove(migrationKey)
  }

  export async function prepareRecovery(progress?: (current: number, total: number) => void) {
    if (!(await isActive())) return
    const pending = await pendingSessions()
    let done = 0
    progress?.(0, pending.length)
    for (const locator of pending) {
      progress?.(++done, pending.length)
      if (locator.retiring) {
        await ensureImported(locator.sessionID)
        continue
      }
      const info = await pendingInfo(locator.scopeID, locator.sessionID)
      if (!info || info.paused || info.working || ["queued", "running"].includes(info.cortex?.status ?? ""))
        await ensureImported(locator.sessionID)
    }
  }

  export async function importBatch(budget: number, options: { deadline?: number; stopped?: () => boolean } = {}) {
    let imported = 0
    let started = 0
    const candidates: StorageCompat.Locator[] = []
    for await (const locator of StorageCompat.catalog(Storage.current().store)) {
      if (candidates.length >= Math.max(0, budget)) break
      if (locator.status === "quarantined" || (locator.retryAfter ?? 0) > Date.now()) continue
      candidates.push(locator)
    }
    await work(1, candidates.reverse(), async (locator) => {
      if (foreground().count || options.stopped?.() || (started > 0 && Date.now() >= (options.deadline ?? Infinity)))
        return
      started++
      try {
        if ((await ensureImported(locator.sessionID, true)).status === "imported") imported++
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        const latest = await StorageCompat.readLocator(Storage.current().store, locator.sessionID)
        if (latest && latest.status !== "imported") {
          const failures = (latest.failures ?? 0) + 1
          await StorageCompat.writeLocator(Storage.current().store, {
            ...latest,
            failures,
            error: {
              category: error instanceof StorageIntegrityError ? "integrity" : "retryable",
              message:
                error instanceof StorageIntegrityError
                  ? "Historical integrity verification failed; inspect the preserved recovery set"
                  : "Historical preparation failed; retry after resolving the storage problem",
            },
            retryAfter: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)),
          })
        }
        log.error("background import failed", { sessionID: locator.sessionID, error })
      }
    })
    const { completeDeferredMigrations } = await import("../migration")
    await completeDeferredMigrations()
    return imported
  }

  export function startBackgroundMigrator(
    options: { intervalMs?: number; budget?: number; busy?: () => boolean } = {},
  ) {
    UpgradeWork.activity(options.busy ?? (() => false))
    const handle = Storage.current()
    let stopped = false
    let running: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay: number) => {
      if (stopped) return
      timer = setTimeout(() => {
        running = Storage.provide(handle, async () => {
          let imported = 0
          let finished = false
          try {
            if (!(await fs.stat(path.join(dataRoot(), "storage", "compat-pause")).catch(missing)))
              imported = await importBatch(options.budget ?? 8, { deadline: Date.now() + 50, stopped: () => stopped })
          } catch (error) {
            log.warn("background compat import tick failed", { error })
          }
          try {
            if (
              !(await UpgradeWork.status()).paused &&
              !options.busy?.() &&
              performance.now() >= maintenance().retryAfter
            ) {
              const task = UpgradeWork.controller(true)
              try {
                await UpgradeWork.run({ background: true, signal: task.controller.signal }, async () => {
                  const cleaned = await SessionSegment.cleanup()
                  const backup = await segmentedBackup()
                  await backup?.sealSnapshots(1)
                  maintenance().failed = false
                  maintenance().failures = 0
                  const counts = await stats()
                  if (
                    !counts.pending &&
                    !counts.partial &&
                    !counts.quarantined &&
                    (!backup || (await backup.completeness()).independent)
                  ) {
                    const { SnapshotProtection } = await import("./snapshot-protection")
                    if (backup) await SnapshotProtection.release(dataRoot(), backup.backupID)
                    finished = !cleaned
                  }
                })
              } finally {
                task.dispose()
              }
            }
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              const state = maintenance()
              state.failed = true
              state.retryAfter = performance.now() + Math.min(60_000, 1000 * 2 ** Math.min(++state.failures, 6))
              log.warn("historical cleanup retained its recovery set", { error })
            }
          }
          if (!finished) schedule(options.intervalMs ?? (imported ? 25 : 1000))
        }).catch((error) => log.warn("background compat import stopped", { error }))
      }, delay)
      timer.unref()
    }
    schedule(options.intervalMs ?? 25)
    return async () => {
      stopped = true
      Storage.provide(handle, () => UpgradeWork.stop())
      clearTimeout(timer)
      await running
    }
  }

  async function pendingInfos(scopeID?: string) {
    const result: Info[] = []
    for await (const entry of StorageCompat.catalog(Storage.current().store, scopeID)) {
      if (entry.status === "quarantined") continue
      const info = await projectedPending(entry.info)
      if (info) result.push(info)
    }
    return result
  }

  async function projectedPending(value: unknown) {
    if (!value) return
    try {
      return await projectInfo(value)
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
    }
  }

  async function projectInfo(value: unknown): Promise<Info> {
    const { Session } = await import(".")
    const record = z
      .object({ endpoint: z.unknown().optional(), time: z.object({ archived: z.number().optional() }).passthrough() })
      .passthrough()
      .parse(value)
    return Info.parse({ ...record, endpoint: Session.indexEndpoint(record.endpoint, record.time.archived) })
  }

  export async function pendingInfo(scopeID: string, sessionID: string): Promise<Info | undefined> {
    const locator = await StorageCompat.readLocator(Storage.current().store, sessionID)
    if (!locator || locator.scopeID !== scopeID || !["pending", "partial"].includes(locator.status)) return
    const [catalog] = await Storage.readMany<StorageCompat.Catalog>([StorageCompat.catalogKey(locator)])
    return projectedPending(catalog?.info)
  }

  export async function pendingEndpoint(endpoint: SessionEndpoint.Info, scopeID?: string) {
    const { SessionEndpoint } = await import("./endpoint")
    const key = SessionEndpoint.toKey(endpoint)
    const info = (await pendingInfos(scopeID)).find(
      (info) => !info.time.archived && info.endpoint && SessionEndpoint.toKey(info.endpoint) === key,
    )
    if (!info) return
    await requireImported(info.id)
    return info.id
  }

  export async function mergePageIndex(scopeID: string, index: Session.PageIndex): Promise<Session.PageIndex> {
    if (!(await isActive())) return index
    const { Session } = await import(".")
    const entries = index.entries.slice()
    const known = new Set(entries.map((entry) => entry.id))
    for (const info of await pendingInfos(scopeID))
      if (!known.has(info.id)) entries.push(Session.toPageIndexEntry(info))
    entries.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
    return { entries }
  }

  export async function mergeNavIndex(scopeID: string, index: ScopeNavIndex): Promise<ScopeNavIndex> {
    if (!(await isActive())) return index
    const { Session } = await import(".")
    const entries = index.entries.slice()
    const known = new Set(entries.map((entry) => entry.id))
    for (const info of await pendingInfos(scopeID)) if (!known.has(info.id)) entries.push(Session.toNavEntry(info))
    entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
    return { ...index, entries }
  }

  export async function mergeChildIndex(
    scopeID: string,
    parentID: string,
    index: Session.ChildIndex,
  ): Promise<Session.ChildIndex> {
    if (!(await isActive())) return index
    const { Session } = await import(".")
    const entries = index.entries.slice()
    const known = new Set(entries.map((entry) => entry.id))
    for (const info of await pendingInfos(scopeID))
      if (info.parentID === parentID && !known.has(info.id)) entries.push(Session.toChildIndexEntry(info))
    entries.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
    return { ...index, entries }
  }

  async function importAggregate(locator: StorageCompat.Locator, stageOnly = false): Promise<StorageCompat.Locator> {
    const backup = await segmentedBackup()
    if (backup)
      return SessionSegment.importOwner(locator, backup, stageOnly, {
        validate: projectInfo,
        quarantine,
        indexes: writeSessionIndexes,
      })
    const backedUp = undefined
    const lock = { directory: path.join(dataRoot(), "storage", ".locks"), key: "artifact-packs" }
    const staged = await withFileLock(lock, () => importAggregateLocked(locator, true, backup, backedUp))
    if (stageOnly || staged.status === "quarantined" || staged.status === "imported") return staged
    const { migrateDeferredSession } = await import("../migration")
    await migrateDeferredSession(staged, "canonical")
    const { RolloutRecovery } = await import("./rollout/recovery")
    await RolloutRecovery.owner({ kind: "session", scopeID: staged.scopeID, sessionID: staged.sessionID })
    return withFileLock(lock, () => importAggregateLocked(staged, false, backup, backedUp))
  }

  async function importAggregateLocked(
    locator: StorageCompat.Locator,
    stageOnly: boolean,
    backup?: SegmentedBackup,
    backedUp?: Map<string, PackedBackupEntry>,
  ): Promise<StorageCompat.Locator> {
    const root = backup?.sourceRoot ?? dataRoot()
    const prefix = `sessions/${locator.scopeID}/${locator.sessionID}/`
    const directory = path.join(root, "sessions", locator.scopeID, locator.sessionID)
    const inventory = await Array.fromAsync(legacyFiles(directory)).catch((error) => {
      missing(error)
      return []
    })
    const files = inventory.filter(
      (file) => legacyRecordKey(prefix + file.relative) || legacyBinaryKey(prefix + file.relative),
    )
    const checkpoints = new Map<string, string>()
    const keys = await Storage.list(["compat_import", "files", locator.sessionID])
    const hashes = await Storage.readMany<string>(keys)
    keys.forEach((key, i) => {
      const relative = key.at(-1)!
      if (
        !relative.startsWith(prefix) ||
        relative.split("/").some((part) => !part || part === "." || part === "..") ||
        !(legacyRecordKey(relative) || legacyBinaryKey(relative))
      )
        throw new StorageIntegrityError("Deferred file checkpoint escaped its Session owner")
      if (backedUp && hashes[i] !== backedUp.get(relative)?.hash)
        throw new StorageIntegrityError("Deferred checkpoint differs from its sealed backup")
      if (hashes[i]) checkpoints.set(relative, hashes[i]!)
    })
    if (backedUp) {
      const available = new Set(files.map((file) => prefix + file.relative))
      for (const relative of backedUp.keys()) {
        if (!(legacyRecordKey(relative) || legacyBinaryKey(relative))) continue
        if (!available.has(relative) && !(locator.retiring && checkpoints.has(relative)))
          throw new StorageIntegrityError("Frozen Session source is missing a record from its sealed backup")
      }
    }
    if (!locator.retiring && !files.some((file) => file.relative === "info.json"))
      return quarantine(locator, prefix + "info.json", "Missing legacy Session metadata")
    if (files.some((file) => file.linkTarget !== undefined))
      throw new StorageIntegrityError("Authoritative deferred records cannot be symbolic links")
    const pack = new ArtifactPack(path.join(dataRoot(), "agent-artifacts"))
    let writes: Array<{ key: string[]; value: unknown }> = []
    let artifacts: Array<{ key: string[]; location: ArtifactLocation }> = []
    let pendingHashes: Array<{ key: string[]; value: string }> = []
    let bytes = 0
    const flush = async () => {
      if (!pendingHashes.length) return
      await Storage.transaction(async (tx) => {
        await tx.writeMany([...writes, ...pendingHashes])
        await tx.writeArtifacts(artifacts)
        await StorageCompat.setLocator(tx, { ...locator, status: "partial" })
      })
      for (const checkpoint of pendingHashes) checkpoints.set(checkpoint.key.at(-1)!, checkpoint.value)
      writes = []
      artifacts = []
      pendingHashes = []
      bytes = 0
    }
    for (const file of files) {
      const relative = prefix + file.relative
      if (checkpoints.has(relative)) continue
      if (locator.retiring) throw new StorageIntegrityError("Deferred legacy data changed during retirement")
      const absolute = path.join(directory, file.relative)
      const key = legacyRecordKey(relative)
      let hash: string
      if (key) {
        const raw = await fs.readFile(absolute)
        hash = createHash("sha256").update(raw).digest("hex")
        if (backedUp && hash !== backedUp.get(relative)?.hash)
          throw new StorageIntegrityError("Frozen Session source changed after backup")
        let value: unknown
        try {
          value = JSON.parse(raw.toString("utf8"))
          validateLegacyRecord(key, value)
        } catch (error) {
          if (!(error instanceof SyntaxError || error instanceof StorageIntegrityError)) throw error
          return quarantine(locator, relative, error.message)
        }
        if (bytes + raw.length > 4 * 1024 * 1024) await flush()
        writes.push({ key, value })
        bytes += raw.length
      } else if (backedUp) {
        await flush()
        const entry = backedUp.get(relative)
        if (!entry) throw new StorageIntegrityError("Frozen Session source changed after backup")
        hash = entry.hash
        const name = await pack.adopt(entry.packed)
        artifacts.push({
          key: legacyBinaryKey(relative)!,
          location: {
            pack: name,
            blockOffset: entry.packed.blockOffset,
            blockBytes: entry.packed.storedBytes,
            decodedBytes: entry.packed.decodedBytes,
            offset: entry.packed.offset,
            size: entry.size,
            codec: entry.packed.codec,
            sha256: hash,
          },
        })
      } else {
        await flush()
        const binaryKey = legacyBinaryKey(relative)!
        const temporary = path.join(root, ".tmp-compat-" + randomUUID())
        try {
          await fs.copyFile(absolute, temporary)
          await fs.chmod(temporary, 0o600)
          const copied = await fs.open(temporary, "r+")
          try {
            await copied.sync()
          } finally {
            await copied.close()
          }
          hash = await digest(temporary)
          const size = (await fs.stat(temporary)).size
          const name = await pack.adopt({ filename: temporary, sha256: hash })
          artifacts.push({
            key: binaryKey,
            location: {
              pack: name,
              blockOffset: 0,
              blockBytes: size,
              decodedBytes: size,
              offset: 0,
              size,
              codec: "raw",
              sha256: hash,
            },
          })
        } finally {
          await fs.rm(temporary, { force: true })
        }
      }
      pendingHashes.push({ key: StorageCompat.fileCheckpointKey(locator.sessionID, relative), value: hash })
      if (writes.length >= 128 || artifacts.length) await flush()
    }
    await flush()
    if (stageOnly && !locator.retiring) {
      const staged: StorageCompat.Locator = { ...locator, status: "partial", staged: true }
      await StorageCompat.writeLocator(Storage.current().store, staged)
      return staged
    }
    try {
      await projectInfo(
        await Storage.read(
          StoragePath.sessionInfo(Identifier.asScopeID(locator.scopeID), Identifier.asSessionID(locator.sessionID)),
        ),
      )
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      return quarantine(locator, prefix + "info.json", "Session metadata does not match the current schema")
    }
    for (const [relative, expected] of checkpoints) {
      const actual = await digest(path.join(root, relative)).catch((error) => {
        if (!locator.retiring) throw error
        missing(error)
      })
      if (actual !== undefined && actual !== expected)
        throw new StorageIntegrityError("Deferred legacy data changed during its import")
      const binaryKey = legacyBinaryKey(relative)
      if (binaryKey) await pack.verify(await Storage.current().store.snapshot((tx) => tx.artifact(binaryKey)))
    }
    await StorageCompat.writeLocator(Storage.current().store, { ...locator, status: "partial", retiring: true })
    for (const relative of checkpoints.keys()) await fs.rm(path.join(root, relative), { force: true })
    await syncRetiredDirectories(
      root,
      [...checkpoints.keys()].map((relative) => path.dirname(path.join(root, relative))),
    )
    const imported: StorageCompat.Locator = {
      sessionID: locator.sessionID,
      scopeID: locator.scopeID,
      activity: locator.activity,
      status: "imported",
    }
    try {
      await Storage.transaction(async (tx) => {
        const { migrateDeferredSession } = await import("../migration")
        await migrateDeferredSession(locator, "derived")
        await writeSessionIndexes(locator)
        await StorageCompat.setLocator(tx, imported)
        await tx.removeTree(["compat_import", "files", locator.sessionID])
      })
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      return quarantine(locator, prefix + "info.json", "Session metadata does not match the current schema")
    }
    const { completeDeferredMigrations } = await import("../migration")
    await completeDeferredMigrations()
    return imported
  }

  async function quarantine(locator: StorageCompat.Locator, relative: string, error: string) {
    const blocked: StorageCompat.Locator = { ...locator, status: "quarantined", source: relative }
    const id = createHash("sha256").update(relative).digest("hex")
    await Storage.transaction(async (tx) => {
      await StorageCompat.setLocator(tx, blocked)
      await tx.write(["storage_recovery", "sessions", locator.sessionID, "info"], {
        blocked: true,
        reason: "historical_data_gap",
        scopeID: locator.scopeID,
      })
      await tx.write(["storage_recovery", "sessions", locator.sessionID, "issues", id], { source: relative, error })
    })
    return blocked
  }

  export async function writeSessionIndexes(locator: { scopeID: string; sessionID: string }) {
    const { Session } = await import(".")
    const sessionID = Identifier.asSessionID(locator.sessionID)
    const [indexed] = await Storage.readMany<{ scopeID: string }>([StoragePath.sessionIndex(sessionID)])
    const scopeID = Identifier.asScopeID(indexed?.scopeID ?? locator.scopeID)
    const session = await projectInfo(await Storage.read(StoragePath.sessionInfo(scopeID, sessionID)))
    await Storage.transaction(async () => {
      await Storage.write(StoragePath.sessionIndex(sessionID), Session.toIndex(session))
      await Session.upsertPageIndexEntry(scopeID, Session.toPageIndexEntry(session))
      if (session.parentID)
        await Session.upsertChildIndexEntry(scopeID, session.parentID, Session.toChildIndexEntry(session))
      const { SessionNav } = await import("./nav")
      await SessionNav.upsertNavEntry(Session.toNavEntry(session))
      if (session.endpoint) {
        const { SessionEndpoint } = await import("./endpoint")
        await Storage.write(StoragePath.endpointSession(SessionEndpoint.toKey(session.endpoint), sessionID), {
          sessionID: session.id,
          scopeID,
        })
      }
      const { SessionSearchIndex } = await import("./search-index")
      await SessionSearchIndex.markDirty(scopeID, sessionID)
    })
  }
}

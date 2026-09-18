import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "../global"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { ArtifactPack } from "../storage/artifact-pack"
import type { ArtifactLocation } from "../storage/artifact-location"
import { StorageCompat } from "../storage/compat"
import { StorageIntegrityError } from "../storage/errors"
import { legacyBinaryKey, legacyFiles, legacyRecordKey, syncRetiredDirectories } from "../storage/legacy-source"
import { validateLegacyRecord } from "../storage/legacy-record"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import type { Info } from "./types"

const log = Log.create({ service: "session.compat-import" })

export interface SessionReplay {
  id: string
  run(input: { scopeID: string; sessionID: string }): Promise<void>
}

/**
 * Populated by the session migration module at import time: replaying a
 * migration for one freshly imported aggregate reuses the same transform code
 * as the global migration, without writing the domain migration log (the
 * global runner owns it) and without one-time global cleanups.
 */
const replays: SessionReplay[] = []

export function registerSessionReplays(entries: SessionReplay[]) {
  replays.push(...entries)
}

const locatorCaches = new WeakMap<object, Map<string, StorageCompat.Locator>>()
const inFlightImports = new WeakMap<object, Map<string, Promise<StorageCompat.Locator>>>()

function locatorCache(store: object) {
  let cache = locatorCaches.get(store)
  if (!cache) {
    cache = new Map()
    locatorCaches.set(store, cache)
  }
  return cache
}

function inFlightFor(store: object) {
  let cache = inFlightImports.get(store)
  if (!cache) {
    cache = new Map()
    inFlightImports.set(store, cache)
  }
  return cache
}

function remember(store: object, locator: StorageCompat.Locator) {
  locatorCache(store).set(locator.sessionID, locator)
  return locator
}

async function digest(filename: string) {
  const hash = createHash("sha256")
  hash.update(await fs.readFile(filename))
  return hash.digest("hex")
}

function pauseFile() {
  return path.join(Global.Path.data, "storage", "compat-pause")
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

  let compatActive: boolean | undefined

  /** Cheap one-shot gate: compat mode is fixed by the manifest at activation. */
  export async function isActive() {
    if (compatActive !== undefined) return compatActive
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(Global.Path.root, "data", "storage", "manifest.json"), "utf8"),
      ) as { compatBoundary?: string }
      compatActive = raw.compatBoundary !== undefined
    } catch {
      compatActive = false
    }
    return compatActive
  }

  /** Quarantine evidence for a session whose aggregate never imported. */
  export async function blockedSource(sessionID: string) {
    const store = Storage.current().store
    const cached = locatorCache(store).get(sessionID)
    if (cached) return cached.status === "quarantined" ? (cached.source ?? "quarantined data") : undefined
    const locator = await StorageCompat.readLocator(store, sessionID)
    return locator?.status === "quarantined" ? (locator.source ?? "quarantined data") : undefined
  }

  /**
   * Import the aggregate behind this session if it still lives in legacy JSON.
   * Returns the settled locator; callers treat anything but "imported" as
   * blocked. Concurrent calls for one session share a single import, and
   * sessions without a locator (created after activation) pass through.
   */
  export async function ensureImported(sessionID: string): Promise<StorageCompat.Locator> {
    const store = Storage.current().store
    const cache = locatorCache(store)
    const cached = cache.get(sessionID)
    if (cached) return cached
    const pending = inFlightFor(store).get(sessionID)
    if (pending) return pending
    const run = (async () => {
      const locator = await StorageCompat.readLocator(store, sessionID)
      if (!locator) return remember(store, { sessionID, scopeID: "", status: "imported" })
      if (locator.status === "pending" || locator.status === "partial")
        return remember(store, await importAggregate(store, locator))
      return remember(store, locator)
    })()
    inFlightFor(store).set(sessionID, run)
    try {
      return await run
    } finally {
      inFlightFor(store).delete(sessionID)
    }
  }

  export async function requireImported(sessionID: string) {
    const locator = await ensureImported(sessionID)
    if (locator.status !== "imported") throw new BlockedError(sessionID, locator.source ?? "quarantined data")
    return locator
  }

  export async function stats() {
    const keys = await Storage.list(["compat_import", "sessions"])
    const all = await Storage.readMany<StorageCompat.Locator>(keys)
    const counts = { pending: 0, partial: 0, imported: 0, quarantined: 0, total: keys.length }
    for (const locator of all) if (locator) counts[locator.status]++
    return counts
  }

  export async function pendingSessions() {
    return StorageCompat.pendingLocators(Storage.current().store)
  }

  /**
   * Imports pending aggregates oldest-first. Returns the number imported.
   * Failures are contained: parse errors quarantine that aggregate, other
   * errors are logged and retried on a later tick (checkpoints resume).
   */
  export async function importBatch(budget: number) {
    let imported = 0
    for (const locator of await pendingSessions()) {
      if (imported >= budget) break
      try {
        const result = await ensureImported(locator.sessionID)
        if (result.status === "imported") imported++
      } catch (error) {
        if (error instanceof BlockedError) continue
        log.error("background import failed", { sessionID: locator.sessionID, error })
      }
    }
    return imported
  }

  let migratorStarted = false

  /** Idle-time convergence loop; no-op without pending aggregates. */
  export function startBackgroundMigrator(options: { intervalMs?: number; budget?: number } = {}) {
    if (migratorStarted) return
    migratorStarted = true
    const intervalMs = options.intervalMs ?? 30_000
    const tick = async () => {
      try {
        if (
          !(await fs
            .stat(pauseFile())
            .then(() => true)
            .catch(() => false))
        ) {
          if ((await importBatch(options.budget ?? 4)) === 0 && !(await pendingSessions()).length) return
        }
      } catch (error) {
        log.warn("background compat import tick failed", { error })
      }
      setTimeout(tick, intervalMs).unref()
    }
    setTimeout(tick, intervalMs).unref()
  }

  async function pendingInfos(scopeID: string) {
    const result: Array<{ locator: StorageCompat.Locator; info: Info }> = []
    for (const locator of await pendingSessions()) {
      if (locator.scopeID !== scopeID) continue
      const filename = path.join(Global.Path.data, "sessions", scopeID, locator.sessionID, "info.json")
      const raw = await fs.readFile(filename, "utf8").catch((error) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
        return undefined
      })
      if (!raw) continue
      try {
        result.push({ locator, info: JSON.parse(raw) as Info })
      } catch {
        // Unreadable aggregate: invisible in listings until a touch quarantines it.
      }
    }
    return result
  }

  /** The stored info.json of a session whose aggregate is still deferred. */
  export async function pendingInfo(scopeID: string, sessionID: string) {
    if (!(await isActive())) return undefined
    const filename = path.join(Global.Path.data, "sessions", scopeID, sessionID, "info.json")
    const raw = await fs.readFile(filename, "utf8").catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      return undefined
    })
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as Info
    } catch {
      return undefined
    }
  }

  export async function mergePageIndex(
    scopeID: string,
    index: {
      entries: Array<{
        id: string
        updated: number
        created: number
        pinned: number
        archived: boolean
        parentID?: string
      }>
    },
  ) {
    if (!(await isActive())) return index
    const pending = await pendingInfos(scopeID)
    if (!pending.length) return index
    const entries = index.entries.slice()
    const known = new Set(entries.map((entry) => entry.id))
    for (const { info } of pending) {
      if (known.has(info.id)) continue
      entries.push({
        id: info.id,
        updated: info.time.updated,
        created: info.time.created,
        pinned: info.pinned ?? 0,
        archived: !!info.time.archived,
        parentID: info.parentID,
      })
    }
    entries.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
    return { entries }
  }

  export async function mergeNavIndex(
    scopeID: string,
    index: { version?: number; scopeID: string; updatedAt?: number; entries: unknown[] },
  ) {
    if (!(await isActive())) return index
    const pending = await pendingInfos(scopeID)
    if (!pending.length) return index
    const { Session } = await import(".")
    const entries = index.entries.slice() as Array<Record<string, unknown>>
    const known = new Set(entries.map((entry) => entry.id))
    for (const { info } of pending) {
      if (known.has(info.id)) continue
      entries.push(Session.toNavEntry(info) as unknown as Record<string, unknown>)
    }
    entries.sort(
      (a, b) => (b.lastActivityAt as number) - (a.lastActivityAt as number) || String(b.id).localeCompare(String(a.id)),
    )
    return { ...index, entries }
  }

  export async function mergeChildIndex(
    scopeID: string,
    parentID: string,
    index: {
      version: 1
      scopeID: string
      parentID: string
      updatedAt: number
      entries: Array<Record<string, unknown>>
    },
  ) {
    if (!(await isActive())) return index
    const pending = await pendingInfos(scopeID)
    if (!pending.length) return index
    const { Session } = await import(".")
    const entries = index.entries.slice()
    const known = new Set(entries.map((entry) => entry.id))
    for (const { info } of pending) {
      if (info.parentID !== parentID || known.has(info.id)) continue
      entries.push(Session.toChildIndexEntry(info) as unknown as Record<string, unknown>)
    }
    entries.sort((a, b) => (b.updated as number) - (a.updated as number) || String(b.id).localeCompare(String(a.id)))
    return { ...index, entries }
  }

  async function importAggregate(store: object, locator: StorageCompat.Locator): Promise<StorageCompat.Locator> {
    const dataRoot = Global.Path.data
    const sessionDir = path.join(dataRoot, "sessions", locator.scopeID, locator.sessionID)
    const relative = (file: { relative: string }) => `sessions/${locator.scopeID}/${locator.sessionID}/${file.relative}`
    let files: Array<{ relative: string; size: number }> = []
    try {
      files = await Array.fromAsync(legacyFiles(sessionDir))
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
    }
    const checkpoints = new Map<string, string>()
    for (const key of await Storage.list(["compat_import", "files", locator.sessionID])) {
      const hash = await Storage.read<string>(key)
      if (hash) checkpoints.set(key[key.length - 1], hash)
    }

    const pack = new ArtifactPack(path.join(dataRoot, "agent-artifacts"))
    let batch: Array<{ key: string[]; value: unknown } | { artifactKey: string[]; content: Buffer }> = []
    let checkpointWrites: Array<{ relative: string; hash: string }> = []
    const flush = async () => {
      if (!batch.length && !checkpointWrites.length) return
      const records = batch
      const hashes = checkpointWrites
      batch = []
      checkpointWrites = []
      const artifacts: Array<{ key: string[]; location: ArtifactLocation }> = []
      const writes: Array<{ key: string[]; value: unknown }> = []
      for (const entry of records) {
        if ("artifactKey" in entry) {
          // Pack bytes are written before the transaction; an interrupted
          // append leaves an orphaned block that artifact GC collects.
          const location = await pack.append(entry.content, locator.sessionID)
          artifacts.push({ key: entry.artifactKey, location })
        } else writes.push(entry)
      }
      await Storage.transaction(async (tx) => {
        await tx.writeMany(writes)
        await tx.writeArtifacts(artifacts)
        for (const checkpoint of hashes) {
          await tx.write(StorageCompat.fileCheckpointKey(locator.sessionID, checkpoint.relative), checkpoint.hash)
          checkpoints.set(checkpoint.relative, checkpoint.hash)
        }
        await tx.write(StorageCompat.locatorKey(locator.sessionID), { ...locator, status: "partial" })
      })
    }

    for (const file of files) {
      const rel = relative(file)
      if (checkpoints.has(rel)) continue
      const absolute = path.join(sessionDir, file.relative)
      const hash = await digest(absolute)
      const recordKey = legacyRecordKey(rel)
      const binaryKey = legacyBinaryKey(rel)
      if (recordKey) {
        let value: unknown
        try {
          value = JSON.parse(await fs.readFile(absolute, "utf8"))
          validateLegacyRecord(recordKey, value)
        } catch (error) {
          const reason = error instanceof SyntaxError ? "Invalid JSON" : String((error as Error).message)
          return remember(store, await quarantine(locator, rel, reason))
        }
        batch.push({ key: recordKey, value })
      } else if (binaryKey) {
        batch.push({ artifactKey: binaryKey, content: await fs.readFile(absolute) })
      }
      checkpointWrites.push({ relative: rel, hash })
      if (batch.length >= 128) await flush()
    }
    await flush()

    for (const replay of replays) {
      try {
        await replay.run({ scopeID: locator.scopeID, sessionID: locator.sessionID })
      } catch (error) {
        log.warn("session replay failed", { sessionID: locator.sessionID, replay: replay.id, error })
      }
    }
    await writeSessionIndexes(locator)

    for (const file of files) {
      const rel = relative(file)
      const expected = checkpoints.get(rel)
      const absolute = path.join(sessionDir, file.relative)
      if (!expected) throw new StorageIntegrityError(`Deferred legacy file ${rel} was imported without a checkpoint`)
      try {
        if ((await digest(absolute)) !== expected)
          throw new StorageIntegrityError("Deferred legacy data changed during its import")
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      }
      await fs.rm(absolute, { force: true })
    }
    await syncRetiredDirectories(
      dataRoot,
      files.map((file) => path.dirname(path.join(sessionDir, file.relative))),
    )
    const imported: StorageCompat.Locator = { ...locator, status: "imported" }
    await Storage.transaction(async (tx) => {
      await tx.write(StorageCompat.locatorKey(locator.sessionID), imported)
      await tx.removeTree(["compat_import", "files", locator.sessionID])
    })
    return remember(store, imported)
  }

  async function quarantine(locator: StorageCompat.Locator, relative: string, error: string) {
    const blocked: StorageCompat.Locator = { ...locator, status: "quarantined", source: relative }
    const id = createHash("sha256").update(relative).digest("hex")
    await Storage.transaction(async (tx) => {
      await tx.write(StorageCompat.locatorKey(locator.sessionID), blocked)
      await tx.write(["storage_recovery", "sessions", locator.sessionID, "info"], {
        blocked: true,
        reason: "historical_data_gap",
        scopeID: locator.scopeID,
      })
      await tx.write(["storage_recovery", "sessions", locator.sessionID, "issues", id], {
        source: relative,
        error,
      })
    })
    return blocked
  }

  /** Current-shape index entries so an imported aggregate is visible without a global rebuild. */
  async function writeSessionIndexes(locator: StorageCompat.Locator) {
    const { Session } = await import(".")
    const scopeID = Identifier.asScopeID(locator.scopeID)
    const sessionID = Identifier.asSessionID(locator.sessionID)
    const session = await Storage.read<Info>(StoragePath.sessionInfo(scopeID, sessionID))
    if (!session) return
    await Storage.transaction(async () => {
      await Storage.write(StoragePath.sessionIndex(sessionID), Session.toIndex(session))
      await Session.upsertPageIndexEntry(locator.scopeID, Session.toPageIndexEntry(session))
      if (session.parentID)
        await Session.upsertChildIndexEntry(locator.scopeID, session.parentID, Session.toChildIndexEntry(session))
      const { SessionNav } = await import("./nav")
      await SessionNav.upsertNavEntry(Session.toNavEntry(session))
      if (session.endpoint) {
        const { SessionEndpoint } = await import("./endpoint")
        await Storage.write(StoragePath.endpointSession(SessionEndpoint.toKey(session.endpoint), sessionID), {
          sessionID: session.id,
          scopeID: locator.scopeID,
        })
      }
      const { SessionSearchIndex } = await import("./search-index")
      await SessionSearchIndex.markDirty(scopeID, sessionID)
    })
  }
}

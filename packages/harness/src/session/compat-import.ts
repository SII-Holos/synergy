import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
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
import { Info } from "./types"
import type { SessionEndpoint } from "./endpoint"
import type { ScopeNavIndex } from "./nav"
import type { Session } from "."

const log = Log.create({ service: "session.compat-import" })
const inFlight = new WeakMap<object, Map<string, Promise<StorageCompat.Locator>>>()
const migrationKey = ["compat_import", "migration"]

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

  export async function ensureImported(sessionID: string): Promise<StorageCompat.Locator> {
    const store = Storage.current().store
    let flights = inFlight.get(store)
    if (!flights) {
      flights = new Map()
      inFlight.set(store, flights)
    }
    const pending = flights.get(sessionID)
    if (pending) return pending
    const run = (async () => {
      const locator = await StorageCompat.readLocator(store, sessionID)
      if (!locator) return { sessionID, scopeID: "", status: "imported" as const }
      if (locator.status === "imported" || locator.status === "quarantined") return locator
      if ((await Storage.readMany([migrationKey]))[0]) {
        throw new StorageIntegrityError("Deferred sessions await completion of the owning domain migrations")
      }
      return importAggregate(locator)
    })()
    flights.set(sessionID, run)
    try {
      return await run
    } finally {
      flights.delete(sessionID)
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

  export function pendingSessions() {
    return StorageCompat.pendingLocators(Storage.current().store)
  }

  export async function stageForMigrations() {
    if (!(await isActive())) return
    await Storage.write(migrationKey, { running: true })
    const locators = await Storage.readMany<StorageCompat.Locator>(await Storage.list(["compat_import", "sessions"]))
    for (const locator of locators) {
      if (!locator || locator.status === "imported") continue
      const staged = locator.status === "quarantined" ? locator : await importAggregate(locator, true)
      if (staged.status === "quarantined") throw new BlockedError(staged.sessionID, staged.source ?? "quarantined data")
    }
  }

  export async function migrationsCompleted() {
    if ((await Storage.readMany([migrationKey]))[0]) await Storage.remove(migrationKey)
  }

  export async function prepareRecovery() {
    if (!(await isActive())) return
    for (const locator of await pendingSessions()) {
      if (locator.staged || locator.retiring) {
        await requireImported(locator.sessionID)
        continue
      }
      const info = await pendingInfo(locator.scopeID, locator.sessionID)
      if (
        !info ||
        info.time.archived === undefined ||
        info.pendingReply ||
        info.working ||
        ["queued", "running"].includes(info.cortex?.status ?? "")
      )
        await ensureImported(locator.sessionID)
    }
  }

  export async function importBatch(budget: number) {
    let imported = 0
    for (const locator of (await pendingSessions()).slice(0, Math.max(0, budget))) {
      try {
        if ((await ensureImported(locator.sessionID)).status === "imported") imported++
      } catch (error) {
        log.error("background import failed", { sessionID: locator.sessionID, error })
      }
    }
    return imported
  }

  export function startBackgroundMigrator(options: { intervalMs?: number; budget?: number } = {}) {
    const handle = Storage.current()
    let stopped = false
    let running: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(() => {
        running = Storage.provide(handle, async () => {
          try {
            if (!(await fs.stat(path.join(dataRoot(), "storage", "compat-pause")).catch(missing)))
              await importBatch(options.budget ?? 4)
          } catch (error) {
            log.warn("background compat import tick failed", { error })
          }
          if ((await pendingSessions()).length) schedule()
        }).catch((error) => log.warn("background compat import stopped", { error }))
      }, options.intervalMs ?? 30_000)
      timer.unref()
    }
    schedule()
    return async () => {
      stopped = true
      clearTimeout(timer)
      await running
    }
  }

  async function pendingInfos(scopeID?: string) {
    const result: Info[] = []
    for (const locator of await pendingSessions()) {
      if (scopeID && locator.scopeID !== scopeID) continue
      const info = await pendingInfo(locator.scopeID, locator.sessionID)
      if (info) result.push(info)
    }
    return result
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
    const raw = await fs
      .readFile(path.join(dataRoot(), "sessions", scopeID, sessionID, "info.json"), "utf8")
      .catch(missing)
    if (!raw) return
    try {
      const value: unknown = JSON.parse(raw)
      validateLegacyRecord(["sessions", scopeID, sessionID, "info"], value)
      return await projectInfo(value)
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof StorageIntegrityError || error instanceof z.ZodError))
        throw error
    }
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
    return withFileLock({ directory: path.join(dataRoot(), "storage", ".locks"), key: "artifact-packs" }, () =>
      importAggregateLocked(locator, stageOnly),
    )
  }

  async function importAggregateLocked(
    locator: StorageCompat.Locator,
    stageOnly: boolean,
  ): Promise<StorageCompat.Locator> {
    const root = dataRoot()
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
      if (hashes[i]) checkpoints.set(relative, hashes[i]!)
    })
    if (!locator.retiring && !files.some((file) => file.relative === "info.json"))
      return quarantine(locator, prefix + "info.json", "Missing legacy Session metadata")
    if (files.some((file) => file.linkTarget !== undefined))
      throw new StorageIntegrityError("Authoritative deferred records cannot be symbolic links")
    const pack = new ArtifactPack(path.join(root, "agent-artifacts"))
    let writes: Array<{ key: string[]; value: unknown }> = []
    let artifacts: Array<{ key: string[]; location: ArtifactLocation }> = []
    let pendingHashes: Array<{ key: string[]; value: string }> = []
    let bytes = 0
    const flush = async () => {
      if (!pendingHashes.length) return
      await Storage.transaction(async (tx) => {
        await tx.writeMany([...writes, ...pendingHashes])
        await tx.writeArtifacts(artifacts)
        await tx.write(StorageCompat.locatorKey(locator.sessionID), { ...locator, status: "partial" })
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
    if (stageOnly) {
      const staged: StorageCompat.Locator = { ...locator, status: "partial", staged: true }
      await Storage.write(StorageCompat.locatorKey(locator.sessionID), staged)
      return staged
    }
    try {
      await writeSessionIndexes(locator)
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
    await Storage.write(StorageCompat.locatorKey(locator.sessionID), { ...locator, status: "partial", retiring: true })
    for (const relative of checkpoints.keys()) await fs.rm(path.join(root, relative), { force: true })
    await syncRetiredDirectories(
      root,
      [...checkpoints.keys()].map((relative) => path.dirname(path.join(root, relative))),
    )
    const imported: StorageCompat.Locator = {
      sessionID: locator.sessionID,
      scopeID: locator.scopeID,
      status: "imported",
    }
    await Storage.transaction(async (tx) => {
      await tx.write(StorageCompat.locatorKey(locator.sessionID), imported)
      await tx.removeTree(["compat_import", "files", locator.sessionID])
    })
    return imported
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
      await tx.write(["storage_recovery", "sessions", locator.sessionID, "issues", id], { source: relative, error })
    })
    return blocked
  }

  async function writeSessionIndexes(locator: StorageCompat.Locator) {
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

import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotTransfer } from "./snapshot-transfer"

import { StorageBootstrap } from "../storage/bootstrap"
import { SnapshotPack } from "./snapshot-pack"
import { SnapshotRecords } from "./snapshot-records"
import { SnapshotPool } from "./snapshot-pool"

export namespace SnapshotMaintenance {
  const Journal = z.object({
    version: z.literal(2),
    phase: z.enum(["inventoried", "imported", "verified", "protected", "switched", "cleaned"]),
    added: z.number().default(0),
    preserved: z.number().default(0),
  })
  type Journal = z.infer<typeof Journal>
  export interface Statistics {
    bytes: number
    allocatedBytes: number
    files: number
  }
  export interface MigrationResult {
    sessionID: string
    status: "pending" | "migrated" | "skipped" | "failed"
    reason?: string
    objectsAdded?: number
  }
  export interface PoolMigrationResult {
    status: "pending" | "consolidated" | "blocked"
    objectsAdded?: number
    removedBytes?: number
  }

  const { entries, historicalRoots } = SnapshotRecords

  export async function packLegacy(
    dataRoot: string,
    options: {
      scopeID?: string
      sessionID?: string
      apply?: boolean
      signal?: AbortSignal
      progress?: (
        current: number,
        result: { scopeID: string; sessionID: string; freedBytes?: number; error?: string },
      ) => void
    } = {},
  ) {
    if (options.sessionID && !options.scopeID) throw new SnapshotStore.StorageError("A session filter requires a Scope")
    if (options.apply) {
      const manifest = await StorageBootstrap.status(path.dirname(dataRoot))
      if (manifest && manifest.phase !== "active" && (await entries(path.join(dataRoot, "storage", "backups"))).length)
        throw new SnapshotStore.StorageError(
          "Finish or restore the interrupted storage backup before packing its source snapshots",
        )
    }
    const scopes = options.scopeID
      ? [SnapshotStore.component(options.scopeID)]
      : (await entries(path.join(dataRoot, "snapshot")))
          .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
          .map((entry) => entry.name)
          .sort()
    const results: Array<{
      scopeID: string
      sessionID: string
      error?: string
      applied: boolean
      packedObjects: number
      freedBytes: number
      before?: { objects: number; bytes: number; allocatedBytes: number }
      packBytes?: number
    }> = []
    for (const scopeID of scopes) {
      const scopeDirectory = path.join(dataRoot, "snapshot", scopeID)
      const scopeStat = await fs.lstat(scopeDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!scopeStat) continue
      if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink())
        throw new SnapshotStore.StorageError("Snapshot packing requires a local Scope directory")
      const run = async () => {
        for (const entry of await entries(path.join(dataRoot, "snapshot", scopeID))) {
          options.signal?.throwIfAborted()
          if (!entry.isDirectory() || (!/^[a-zA-Z0-9_-]+$/.test(entry.name) && entry.name !== ".shared.old")) continue
          if (options.sessionID && entry.name !== SnapshotStore.component(options.sessionID)) continue
          const repository = path.join(dataRoot, "snapshot", scopeID, entry.name)
          if (!(await Bun.file(path.join(repository, "HEAD")).exists())) continue
          try {
            const result = { scopeID, sessionID: entry.name, ...(await SnapshotPack.loose(repository, options)) }
            results.push(result)
            options.progress?.(results.length, result)
          } catch (error) {
            if (options.signal?.aborted) throw error
            const result = {
              scopeID,
              sessionID: entry.name,
              applied: false,
              packedObjects: 0,
              freedBytes: 0,
              error: error instanceof Error ? error.message : String(error),
            }
            results.push(result)
            options.progress?.(results.length, result)
          }
        }
      }
      if (options.apply) await SnapshotLease.use(scopeID, true, run, { signal: options.signal, dataRoot })
      else await run()
    }
    return { ok: results.every((result) => !result.error), results }
  }

  export async function scopes() {
    const result = new Set<string>(
      (await Storage.scan(["snapshot-v2"])).filter((id) => id !== "format" && id !== "leases"),
    )
    for (const dir of [
      path.join(Storage.current().artifactDirectory, "snapshot"),
      path.join(Storage.current().artifactDirectory, "snapshot-v2"),
    ]) {
      for (const entry of await entries(dir))
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) result.add(entry.name)
    }
    return [...result].sort()
  }

  export async function registerLegacy(
    progress?: (current: number, total: number) => void,
    scopeID?: string,
    sessionID?: string,
  ) {
    if (sessionID && !scopeID) throw new Error("A session filter requires a Scope")
    if (sessionID) SnapshotStore.component(sessionID)
    const ids = scopeID ? [SnapshotStore.component(scopeID)] : await scopes()
    let done = 0
    for (const scopeID of ids) {
      await SnapshotLease.use(scopeID, true, async () => {
        for (const entry of await entries(
          path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID),
        )) {
          if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
          if (sessionID && entry.name !== sessionID) continue
          if (
            !(await Bun.file(
              path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID, entry.name, "HEAD"),
            ).exists())
          )
            continue
          if (await SnapshotStore.owner(scopeID, entry.name)) continue
          await SnapshotStore.write(StoragePath.snapshotOwner(scopeID, entry.name), {
            version: 2,
            backend: "legacy",
          } satisfies SnapshotStore.Owner)
        }
      })
      progress?.(++done, ids.length)
    }
    await SnapshotStore.write(StoragePath.snapshotFormat(), { version: 2 })
  }

  /**
   * Remove legacy owner records that the shared-store migration registered
   * for directories with no session record. The migration predates the
   * session-record ownership proof, so those records make crash- and
   * scope-migration orphans invisible to `clean` forever. A record is
   * released only when its repository is still an unclaimed legacy
   * directory (HEAD present, `legacy` backend, no journal, no session
   * record, shared store untouched); anything else keeps its record.
   */
  export async function releaseOrphanOwners(progress?: (current: number, total: number) => void) {
    const ids = await scopes()
    let done = 0
    for (const scopeID of ids) {
      await SnapshotLease.use(scopeID, true, async () => {
        for (const sessionID of await ownerIDs(scopeID)) {
          const owner = await SnapshotStore.owner(scopeID, sessionID)
          if (owner?.backend !== "legacy") continue
          if (
            !(await Bun.file(
              path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID, sessionID, "HEAD"),
            ).exists())
          )
            continue
          if (await SnapshotStore.optional(StoragePath.snapshotMigration(scopeID, sessionID))) continue
          const info = await SnapshotStore.optional<unknown>(
            StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
          )
          if (info !== undefined) continue
          await Storage.remove(StoragePath.snapshotOwner(scopeID, sessionID))
        }
      })
      progress?.(++done, ids.length)
    }
  }

  export async function statistics(directory: string): Promise<Statistics> {
    const total: Statistics = { bytes: 0, allocatedBytes: 0, files: 0 }
    async function walk(dir: string) {
      for (const entry of await entries(dir)) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile()) {
          const stat = await fs.stat(file)
          total.bytes += stat.size
          total.allocatedBytes += stat.blocks * 512
          total.files++
        }
      }
    }
    await walk(directory)
    return total
  }

  async function ownerIDs(scopeID: string) {
    return Storage.scan(StoragePath.snapshotOwners(scopeID))
  }

  export async function inspect(scopeID?: string) {
    const result = []
    for (const id of scopeID ? [SnapshotStore.component(scopeID)] : await scopes()) {
      const owners = { legacy: 0, shared: 0, deleted: 0 }
      for (const sessionID of await ownerIDs(id)) {
        const owner = await SnapshotStore.owner(id, sessionID)
        if (owner) owners[owner.backend]++
      }
      const legacy = await statistics(path.join(path.join(Storage.current().artifactDirectory, "snapshot"), id))
      const shared = await statistics(SnapshotStore.repository(id))
      const indexes = await statistics(SnapshotStore.cache(id))
      const retainedLegacy = { unowned: 0, reclaimed: 0, sharedBaselines: 0, unregistered: 0 }
      for (const entry of await entries(path.join(path.join(Storage.current().artifactDirectory, "snapshot"), id))) {
        if (!entry.isDirectory()) continue
        if (entry.name === ".shared.old") {
          retainedLegacy.sharedBaselines++
          continue
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
        if (
          !(await Bun.file(
            path.join(path.join(Storage.current().artifactDirectory, "snapshot"), id, entry.name, "HEAD"),
          ).exists())
        )
          continue
        if (!(await SnapshotStore.owner(id, entry.name))) retainedLegacy.unregistered++
        if (id === "__reclaimed__") retainedLegacy.reclaimed++
        else if ((await SnapshotStore.optional(["sessions", id, entry.name, "info"])) === undefined)
          retainedLegacy.unowned++
      }
      result.push({ scopeID: id, owners, retainedLegacy, legacy, shared, indexes })
    }
    return result
  }

  export async function check(scopeID: string, signal?: AbortSignal) {
    return SnapshotLease.use(scopeID, true, () => checkUnlocked(scopeID, signal), { signal })
  }

  async function checkUnlocked(scopeID: string, signal?: AbortSignal) {
    const issues: string[] = []
    let roots = 0
    const shared = SnapshotStore.repository(scopeID)
    if (await Bun.file(path.join(shared, "HEAD")).exists()) {
      if (await Bun.file(path.join(shared, "objects", "info", "alternates")).exists())
        issues.push("Shared store has an external object dependency")
      try {
        await SnapshotGit.checked(shared, ["fsck", "--full"], { signal })
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error))
      }
    }
    const sessions = await Storage.scan(["sessions", scopeID])
    for (const sessionID of new Set([...(await ownerIDs(scopeID)), ...sessions])) {
      signal?.throwIfAborted()
      const owner = await SnapshotStore.owner(scopeID, sessionID)
      if (owner?.backend === "deleted") continue
      if (!owner) {
        if ((await historicalRoots(scopeID, sessionID)).length)
          issues.push(`${sessionID}: historical snapshots have no storage owner`)
        continue
      }
      if (owner.backend === "shared" && !(await Bun.file(path.join(shared, "HEAD")).exists()))
        issues.push(`${sessionID}: shared object store is missing`)
      if (owner.backend === "legacy") {
        try {
          await SnapshotGit.checked(SnapshotStore.legacyRepository(scopeID, sessionID), ["fsck", "--full"], { signal })
        } catch (error) {
          issues.push(`${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        for (const hash of await historicalRoots(scopeID, sessionID)) {
          roots++
          if (!(await SnapshotStore.owns(scopeID, sessionID, hash)))
            issues.push(`${sessionID}: historical snapshot is not retained: ${hash}`)
        }
      } catch (error) {
        issues.push(`${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { scopeID, ok: issues.length === 0, roots, issues }
  }

  export async function migrate(
    scopeID: string,
    options: {
      apply?: boolean
      sessionID?: string
      signal?: AbortSignal
      progress?: (current: number, result: MigrationResult) => void
    } = {},
  ) {
    return SnapshotLease.use(
      scopeID,
      true,
      async () => {
        const results: MigrationResult[] = []
        const pending: string[] = []
        for (const sessionID of await ownerIDs(scopeID)) {
          if (options.sessionID && sessionID !== SnapshotStore.component(options.sessionID)) continue
          const owner = await SnapshotStore.owner(scopeID, sessionID)
          const journal = await SnapshotStore.optional<unknown>(StoragePath.snapshotMigration(scopeID, sessionID))
          if (owner?.backend === "legacy" || (journal && Journal.parse(journal).phase !== "cleaned"))
            pending.push(sessionID)
        }
        const repo = SnapshotStore.repository(scopeID)
        const legacyPool = SnapshotPool.repository(Storage.current().artifactDirectory, scopeID)
        const pool = !options.sessionID && (await SnapshotPool.pending(legacyPool, repo)) ? legacyPool : undefined
        if (!options.apply || (pending.length === 0 && !pool)) {
          return {
            scopeID,
            applied: false,
            results: pending.map((sessionID): MigrationResult => ({ sessionID, status: "pending" })),
            pool: pool ? { status: "pending" as const } : undefined,
          }
        }
        await SnapshotStore.initializeRepository(scopeID)
        await SnapshotGit.checked(repo, ["fsck", "--full"], options)
        await using catalog = await SnapshotTransfer.Catalog.create(repo, options.signal)
        const failed = (sessionID: string, error: unknown): MigrationResult => {
          if (options.signal?.aborted) throw error
          return {
            sessionID,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          }
        }
        for (let offset = 0; offset < pending.length; offset += 32) {
          const batch: Array<{ sessionID: string; prepared: MigrationResult | (() => Promise<MigrationResult>) }> = []
          for (const sessionID of pending.slice(offset, offset + 32)) {
            options.signal?.throwIfAborted()
            try {
              batch.push({ sessionID, prepared: await prepareMigration(scopeID, sessionID, catalog, options.signal) })
            } catch (error) {
              batch.push({ sessionID, prepared: failed(sessionID, error) })
            }
          }
          let publication: { error: unknown } | undefined
          try {
            await catalog.publishReferences(options.signal)
          } catch (error) {
            if (options.signal?.aborted) throw error
            publication = { error }
          }
          for (const { sessionID, prepared } of batch) {
            try {
              results.push(
                typeof prepared !== "function"
                  ? prepared
                  : publication
                    ? failed(sessionID, publication.error)
                    : await prepared(),
              )
            } catch (error) {
              results.push(failed(sessionID, error))
            }
            options.progress?.(results.length, results.at(-1)!)
          }
        }
        let poolResult: PoolMigrationResult | undefined
        if (pool) {
          poolResult = results.every((result) => result.status === "migrated")
            ? { status: "consolidated", ...(await SnapshotPool.consolidate(pool, catalog, options.signal)) }
            : { status: "blocked" }
        }
        await SnapshotGit.checked(repo, ["fsck", "--full"], options)
        return { scopeID, applied: true, results, pool: poolResult }
      },
      { signal: options.signal },
    )
  }

  async function prepareMigration(
    scopeID: string,
    sessionID: string,
    catalog: SnapshotTransfer.Catalog,
    signal?: AbortSignal,
  ): Promise<MigrationResult | (() => Promise<MigrationResult>)> {
    const key = StoragePath.snapshotMigration(scopeID, sessionID)
    const previous = await SnapshotStore.optional<unknown>(key)
    let journal: Journal = previous
      ? Journal.parse(previous)
      : { version: 2, phase: "inventoried", added: 0, preserved: 0 }
    const source = SnapshotStore.legacyRepository(scopeID, sessionID)
    const target = SnapshotStore.repository(scopeID)
    const info = await SnapshotStore.optional<unknown>(
      StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
    )
    if (!info)
      return {
        sessionID,
        status: "skipped",
        reason: "Legacy repository has no confirmed session ownership; retained unchanged",
      }
    if (journal.phase !== "switched" && journal.phase !== "cleaned") {
      await SnapshotStore.write(key, journal)
      await SnapshotGit.checked(source, ["fsck", "--full"], { signal })
      const roots = await historicalRoots(scopeID, sessionID)
      const imported = await catalog.import(source, {
        signal,
        requiredTrees: roots,
        keepToken: `synergy-migration-${sessionID}`,
      })
      journal = {
        ...journal,
        phase: "imported",
        added: journal.added + imported.added,
      }
      await SnapshotStore.write(key, journal)
      const trees = [...new Set([...roots, ...catalog.trees()])]
      await catalog.verifyTrees(target, trees, signal)
      journal.phase = "verified"
      await SnapshotStore.write(key, journal)
      journal.preserved = await catalog.protect(sessionID, trees, signal, {
        packReferences: true,
        deferPublication: true,
      })
    }
    return async () => {
      signal?.throwIfAborted()
      if (journal.phase !== "switched" && journal.phase !== "cleaned") {
        journal.phase = "protected"
        await SnapshotStore.write(key, journal)
        await SnapshotStore.write(StoragePath.snapshotOwner(scopeID, sessionID), {
          version: 2,
          backend: "shared",
        } satisfies SnapshotStore.Owner)
        journal.phase = "switched"
        await SnapshotStore.write(key, journal)
      }
      if (journal.phase === "switched") {
        if ((await SnapshotStore.owner(scopeID, sessionID))?.backend !== "shared")
          throw new SnapshotStore.StorageError("Cannot clean legacy snapshot without shared ownership")
        await catalog.verifyRetention(sessionID, await historicalRoots(scopeID, sessionID), signal)
        await SnapshotTransfer.releaseKeeps(target, `synergy-migration-${sessionID}`)
        await fs.rm(source, { recursive: true, force: true })
        await fs.rm(SnapshotStore.cache(scopeID, sessionID), { recursive: true, force: true })
        journal.phase = "cleaned"
        await SnapshotStore.write(key, journal)
      }
      return { sessionID, status: "migrated", objectsAdded: journal.added }
    }
  }

  export async function compact(
    scopeID: string,
    options: { apply?: boolean; prune?: boolean; signal?: AbortSignal } = {},
  ) {
    return SnapshotLease.use(
      scopeID,
      true,
      async () => {
        const repo = SnapshotStore.repository(scopeID)
        const before = await statistics(repo)
        if (!options.apply || !(await Bun.file(path.join(repo, "HEAD")).exists()))
          return { scopeID, applied: false, prune: options.prune ?? false, before }
        const health = await checkUnlocked(scopeID, options.signal)
        if (!health.ok) throw new SnapshotStore.StorageError("Snapshot integrity check failed; no objects were pruned")
        let recoveredObjects = 0
        if (options.prune) {
          const packs = await entries(path.join(repo, "objects", "pack"))
          if (packs.some((entry) => entry.name.endsWith(".keep")))
            throw new SnapshotStore.StorageError("Snapshot packs have unresolved import protection")
          for (const dir of ["migrations", "deletions"]) {
            for (const id of await Storage.scan(["snapshot-v2", scopeID, dir])) {
              const record = await Storage.read<unknown>(["snapshot-v2", scopeID, dir, id])
              if (dir === "deletions" || Journal.parse(record).phase !== "cleaned")
                throw new SnapshotStore.StorageError("Snapshot maintenance has unfinished recovery work")
            }
          }
          await fs.rm(SnapshotStore.cache(scopeID), { recursive: true, force: true })
          await SnapshotGit.checked(repo, ["gc", "--prune=now"], options)
        } else {
          recoveredObjects = await SnapshotTransfer.recoverImports(repo, options.signal)
          await SnapshotGit.checked(repo, ["repack", "-ad", "--keep-unreachable"], options)
          await SnapshotGit.checked(repo, ["pack-refs", "--all"], options)
        }
        await SnapshotGit.checked(repo, ["fsck", "--full"], options)
        return {
          scopeID,
          applied: true,
          prune: options.prune ?? false,
          before,
          after: await statistics(repo),
          recoveredObjects,
        }
      },
      { signal: options.signal },
    )
  }

  export interface CleanCandidate {
    sessionID: string
    bytes: number
    reason: "reclaimed" | "unowned"
  }

  export interface CleanResult {
    scopeID: string
    applied: boolean
    candidates: CleanCandidate[]
    removed: number
    bytes: number
    skippedProtected: number
    errors: string[]
  }

  /**
   * True when a legacy directory may be reclaimed: no owner record AND no
   * session record. The session-record check applies to every scope
   * identically — `__reclaimed__` scopes hold session records for kept
   * sessions, so the absence of info.json is required there too. The
   * "reclaimed" reason labels record-less candidates inside `__reclaimed__`
   * only; it never bypasses the record checks.
   */
  async function cleanCandidate(scopeID: string, sessionID: string): Promise<CleanCandidate | undefined> {
    if (await SnapshotStore.owner(scopeID, sessionID)) return undefined
    const info = await SnapshotStore.optional<unknown>(
      StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
    )
    if (info !== undefined) return undefined
    return {
      sessionID,
      bytes: (
        await statistics(path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID, sessionID))
      ).bytes,
      reason: scopeID === "__reclaimed__" ? "reclaimed" : "unowned",
    }
  }

  /**
   * Reclaim retained legacy snapshot directories that nothing owns: no v2
   * owner record and no session record. The shared store, owner records, and
   * directories with either record are never touched. Dry run by default;
   * apply additionally requires the scope integrity check to pass so a
   * corrupted scope is rejected whole instead of partially reclaimed.
   */
  export async function clean(
    scopeID: string,
    options: { apply?: boolean; signal?: AbortSignal } = {},
  ): Promise<CleanResult> {
    return SnapshotLease.use(
      scopeID,
      true,
      async () => {
        const result: CleanResult = {
          scopeID,
          applied: false,
          candidates: [],
          removed: 0,
          bytes: 0,
          skippedProtected: 0,
          errors: [],
        }
        for (const entry of await entries(
          path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID),
        )) {
          if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
          if (
            !(await Bun.file(
              path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID, entry.name, "HEAD"),
            ).exists())
          )
            continue
          const candidate = await cleanCandidate(scopeID, entry.name)
          if (candidate) result.candidates.push(candidate)
          else result.skippedProtected++
        }
        if (!options.apply || result.candidates.length === 0) return result
        const health = await checkUnlocked(scopeID, options.signal)
        if (!health.ok) throw new SnapshotStore.StorageError("Snapshot integrity check failed; nothing was reclaimed")
        result.applied = true
        for (const candidate of result.candidates) {
          options.signal?.throwIfAborted()
          try {
            await fs.rm(
              path.join(path.join(Storage.current().artifactDirectory, "snapshot"), scopeID, candidate.sessionID),
              {
                recursive: true,
                force: true,
              },
            )
            await fs.rm(SnapshotStore.cache(scopeID, candidate.sessionID), { recursive: true, force: true })
            result.removed++
            result.bytes += candidate.bytes
          } catch (error) {
            result.errors.push(`${candidate.sessionID}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return result
      },
      { signal: options.signal },
    )
  }
}

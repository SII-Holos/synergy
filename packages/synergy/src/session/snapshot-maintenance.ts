import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotTransfer } from "./snapshot-transfer"

import { SnapshotRecords } from "./snapshot-records"

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

  const { entries, historicalRoots } = SnapshotRecords

  export async function scopes() {
    const result = new Set<string>()
    for (const dir of [Global.Path.snapshot, path.join(Global.Path.data, "snapshot-v2")]) {
      for (const entry of await entries(dir))
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) result.add(entry.name)
    }
    return [...result].sort()
  }

  export async function registerLegacy(progress?: (current: number, total: number) => void, scopeID?: string) {
    const ids = scopeID ? [SnapshotStore.component(scopeID)] : await scopes()
    let done = 0
    for (const scopeID of ids) {
      await SnapshotLease.use(scopeID, true, async () => {
        for (const entry of await entries(path.join(Global.Path.snapshot, scopeID))) {
          if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
          if (!(await Bun.file(path.join(Global.Path.snapshot, scopeID, entry.name, "HEAD")).exists())) continue
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
    return (await entries(path.join(Global.Path.data, ...StoragePath.snapshotOwners(scopeID))))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort()
  }

  export async function inspect(scopeID?: string) {
    const result = []
    for (const id of scopeID ? [SnapshotStore.component(scopeID)] : await scopes()) {
      const owners = { legacy: 0, shared: 0, deleted: 0 }
      for (const sessionID of await ownerIDs(id)) {
        const owner = await SnapshotStore.owner(id, sessionID)
        if (owner) owners[owner.backend]++
      }
      const legacy = await statistics(path.join(Global.Path.snapshot, id))
      const shared = await statistics(SnapshotStore.repository(id))
      const indexes = await statistics(SnapshotStore.cache(id))
      const retainedLegacy = { unowned: 0, reclaimed: 0, sharedBaselines: 0, unregistered: 0 }
      for (const entry of await entries(path.join(Global.Path.snapshot, id))) {
        if (!entry.isDirectory()) continue
        if (entry.name === ".shared.old") {
          retainedLegacy.sharedBaselines++
          continue
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue
        if (!(await Bun.file(path.join(Global.Path.snapshot, id, entry.name, "HEAD")).exists())) continue
        if (!(await SnapshotStore.owner(id, entry.name))) retainedLegacy.unregistered++
        if (id === "__reclaimed__") retainedLegacy.reclaimed++
        else if (!(await Bun.file(path.join(Global.Path.data, "sessions", id, entry.name, "info.json")).exists()))
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
    const sessions = (await entries(path.join(Global.Path.data, "sessions", scopeID)))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
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

  export async function migrate(scopeID: string, options: { apply?: boolean; signal?: AbortSignal } = {}) {
    return SnapshotLease.use(
      scopeID,
      true,
      async () => {
        const results: MigrationResult[] = []
        const pending: string[] = []
        for (const sessionID of await ownerIDs(scopeID)) {
          const owner = await SnapshotStore.owner(scopeID, sessionID)
          const journal = await SnapshotStore.optional<unknown>(StoragePath.snapshotMigration(scopeID, sessionID))
          if (owner?.backend === "legacy" || (journal && Journal.parse(journal).phase !== "cleaned"))
            pending.push(sessionID)
        }
        if (!options.apply || pending.length === 0) {
          return {
            scopeID,
            applied: false,
            results: pending.map((sessionID): MigrationResult => ({ sessionID, status: "pending" })),
          }
        }
        await SnapshotStore.initializeRepository(scopeID)
        const repo = SnapshotStore.repository(scopeID)
        await SnapshotGit.checked(repo, ["fsck", "--full"], options)
        await using catalog = await SnapshotTransfer.Catalog.create(repo, options.signal)
        for (const sessionID of pending) {
          options.signal?.throwIfAborted()
          try {
            results.push(await migrateOne(scopeID, sessionID, catalog, options.signal))
          } catch (error) {
            if (options.signal?.aborted) throw error
            results.push({
              sessionID,
              status: "failed",
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await SnapshotGit.checked(repo, ["fsck", "--full"], options)
        return { scopeID, applied: true, results }
      },
      { signal: options.signal },
    )
  }

  async function migrateOne(
    scopeID: string,
    sessionID: string,
    catalog: SnapshotTransfer.Catalog,
    signal?: AbortSignal,
  ): Promise<MigrationResult> {
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
    if (!info || scopeID === "__reclaimed__")
      return {
        sessionID,
        status: "skipped",
        reason: "Legacy repository has no confirmed session ownership; retained unchanged",
      }
    if (journal.phase !== "switched" && journal.phase !== "cleaned") {
      await SnapshotStore.write(key, journal)
      await SnapshotGit.checked(source, ["fsck", "--full"], { signal })
      const roots = await historicalRoots(scopeID, sessionID)
      for (const hash of roots) {
        if ((await SnapshotGit.checked(source, ["cat-file", "-t", hash], { signal })) !== "tree")
          throw new SnapshotStore.StorageError("Historical root is not a tree")
      }
      const imported = await catalog.import(source, { signal, keepToken: `synergy-migration-${sessionID}` })
      journal = {
        ...journal,
        phase: "imported",
        added: journal.added + imported.added,
      }
      await SnapshotStore.write(key, journal)
      const trees = [...new Set([...roots, ...catalog.trees()])]
      for (const tree of trees) {
        if ((await SnapshotGit.checked(target, ["cat-file", "-t", tree], { signal })) !== "tree")
          throw new SnapshotStore.StorageError("Imported historical tree is missing")
      }
      journal.phase = "verified"
      await SnapshotStore.write(key, journal)
      journal.preserved = await catalog.protect(sessionID, trees, signal)
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
      for (const hash of await historicalRoots(scopeID, sessionID)) {
        if (!(await SnapshotStore.owns(scopeID, sessionID, hash)))
          throw new SnapshotStore.StorageError("Cannot clean legacy snapshot with an unprotected history root")
      }
      await SnapshotTransfer.releaseKeeps(target, `synergy-migration-${sessionID}`)
      await fs.rm(source, { recursive: true, force: true })
      await fs.rm(SnapshotStore.cache(scopeID, sessionID), { recursive: true, force: true })
      journal.phase = "cleaned"
      await SnapshotStore.write(key, journal)
    }
    return { sessionID, status: "migrated", objectsAdded: journal.added }
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
            for (const entry of await entries(path.join(SnapshotStore.root(scopeID), dir))) {
              if (!entry.isFile() || !entry.name.endsWith(".json")) continue
              const record = await Storage.read<unknown>(["snapshot-v2", scopeID, dir, entry.name.slice(0, -5)])
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
}

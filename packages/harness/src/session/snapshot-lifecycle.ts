import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotProtection } from "./snapshot-protection"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotGit } from "./snapshot-git"

export namespace SnapshotLifecycle {
  const Deletion = z.object({ version: z.literal(2), backend: z.enum(["legacy", "shared"]) })

  async function locked<T>(scopeID: string, sessions: string[], fn: () => Promise<T>) {
    const ids = [...new Set(sessions)].sort().map(SnapshotStore.component)
    function next(index: number): Promise<T> {
      if (index === ids.length) return fn()
      return withFileLock(
        { directory: SnapshotLease.directory(), key: `snapshot-session:${scopeID}:${ids[index]}` },
        () => next(index + 1),
      )
    }
    return SnapshotLease.use(scopeID, false, () => next(0))
  }

  export async function adopt(input: {
    scopeID: string
    sourceSessionID: string
    targetSessionID: string
    hashes: string[]
    allowMissing?: boolean
  }) {
    const hashes = [...new Set(input.hashes)]
    if (!hashes.length) return { missing: [] as string[] }
    return locked(input.scopeID, [input.sourceSessionID, input.targetSessionID], async () => {
      const sourceOwner = await SnapshotStore.owner(input.scopeID, input.sourceSessionID)
      const source =
        sourceOwner?.backend === "legacy"
          ? SnapshotStore.legacyRepository(input.scopeID, input.sourceSessionID)
          : SnapshotStore.repository(input.scopeID)
      const retained: string[] = []
      const missing: string[] = []
      for (const hash of hashes)
        if (!SnapshotStore.OID.test(hash)) throw new SnapshotStore.StorageError("Invalid imported snapshot root")
      const owned = await SnapshotStore.ownsMany(input.scopeID, input.sourceSessionID, hashes)
      for (const hash of hashes) {
        if (owned.has(hash)) {
          retained.push(hash)
          continue
        }
        let exists = false
        if (input.allowMissing)
          exists = await SnapshotStore.command(source, ["cat-file", "-t", hash]).then(
            (type) => type === "tree",
            () => false,
          )
        if (exists) retained.push(hash)
        else missing.push(hash)
      }
      if (missing.length && !input.allowMissing)
        throw new SnapshotStore.StorageError("Fork source has missing snapshot history")
      if (!retained.length) return { missing }
      const target = await SnapshotStore.resolveRepository(input.scopeID, input.targetSessionID)
      await SnapshotStore.initialize(target)
      if (target.backend !== "shared") throw new SnapshotStore.StorageError("Snapshot adoption requires a new session")
      if (sourceOwner?.backend === "legacy") {
        await using catalog = await SnapshotTransfer.Catalog.create(target.repository)
        const imported = await catalog.import(source, { roots: retained })
        await catalog.protect(input.targetSessionID, retained)
        await catalog.releaseKeep(imported.keep)
      } else {
        await SnapshotStore.retainMany(input.scopeID, input.targetSessionID, retained)
      }
      return { missing }
    })
  }

  export async function beginDelete(scopeID: string, sessionID: string) {
    return locked(scopeID, [sessionID], async () => {
      await scheduleDelete(scopeID, sessionID)
    })
  }

  export async function scheduleDelete(scopeID: string, sessionID: string) {
    return Storage.transaction(async () => {
      const key = StoragePath.snapshotDeletion(scopeID, sessionID)
      const previous = await SnapshotStore.optional<unknown>(key)
      if (previous !== undefined) Deletion.parse(previous)
      else {
        const owner = await SnapshotStore.owner(scopeID, sessionID)
        if (owner?.backend === "deleted") return
        await SnapshotStore.write(key, { version: 2, backend: owner?.backend ?? "shared" } satisfies z.infer<
          typeof Deletion
        >)
      }
      await SnapshotStore.write(StoragePath.snapshotOwner(scopeID, sessionID), {
        version: 2,
        backend: "deleted",
      } satisfies SnapshotStore.Owner)
    })
  }

  export async function completeDelete(scopeID: string, sessionID: string) {
    return locked(scopeID, [sessionID], async () => {
      const key = StoragePath.snapshotDeletion(scopeID, sessionID)
      const stored = await SnapshotStore.optional<unknown>(key)
      if (stored === undefined) return
      const job = Deletion.parse(stored)
      const canonical = path.join(
        Storage.current().artifactDirectory,
        ...StoragePath.sessionRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
      )
      const remaining = await Storage.list(
        StoragePath.sessionRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
      )
      if (remaining.length)
        throw new SnapshotStore.StorageError("Cannot release snapshots before permanent session deletion")
      const repo = SnapshotStore.repository(scopeID)
      if (await Bun.file(path.join(repo, "HEAD")).exists()) {
        const prefix = `refs/synergy/snapshots/${SnapshotStore.component(sessionID)}/`
        const directory = SnapshotStore.cache(scopeID, sessionID)
        await fs.mkdir(directory, { recursive: true })
        const file = path.join(directory, "delete-refs")
        await Bun.write(file, "")
        const writer = Bun.file(file).writer()
        try {
          let count = 0
          for await (const ref of SnapshotGit.lines(repo, ["for-each-ref", "--format=%(refname)", prefix])) {
            writer.write(`delete ${ref}\n`)
            if (++count % 1024 === 0) await writer.flush()
          }
        } finally {
          await writer.end()
        }
        await SnapshotGit.checked(repo, ["update-ref", "--stdin"], { input: file })
        await SnapshotTransfer.releaseKeeps(repo, `synergy-migration-${sessionID}`)
      }
      if (job.backend === "legacy" && !(await SnapshotProtection.active(Storage.current().artifactDirectory)))
        await fs.rm(SnapshotStore.legacyRepository(scopeID, sessionID), { recursive: true, force: true })
      await fs.rm(SnapshotStore.cache(scopeID, sessionID), { recursive: true, force: true })
      await fs.rm(canonical, { recursive: true, force: true })
      await Storage.collectArtifactGarbage()
      await Storage.remove(StoragePath.snapshotMigration(scopeID, sessionID))
      await Storage.remove(key)
    })
  }

  export async function recover(scopeID: string) {
    const jobs = await Storage.scan(["snapshot-v2", scopeID, "deletions"])
    const { SessionRecovery } = await import("./recovery")
    for (const sessionID of jobs) {
      const report = await SessionRecovery.remove({ scopeID, sessionID })
      if (report.errors.length) throw new SnapshotStore.StorageError("Snapshot deletion recovery is incomplete")
    }
  }
}

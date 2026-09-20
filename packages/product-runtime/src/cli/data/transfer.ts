import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { authorityRecordRoots, StoragePortable } from "@ericsanchezok/synergy-harness/storage/portable"
import { legacyRecordKey } from "@ericsanchezok/synergy-harness/storage/legacy-import"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCompat } from "@ericsanchezok/synergy-harness/storage/compat"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import {
  archiveExclusions,
  copyDirSkipExisting,
  type CopyProgress,
} from "@ericsanchezok/synergy-cli/cli/cmd/data/shared"

const derived = new Set([
  "session_index",
  "endpoint_session",
  "sessions_page_index",
  "session_child_index",
  "session_nav_v2",
])
const local = new Set([
  "storage_meta",
  "storage_import",
  "storage_import_files",
  "storage_staging",
  "storage_transfer",
  "compat_import",
  "compat_catalog",
])

export namespace DataTransfer {
  export async function lockHomes(roots: string[]) {
    for (const root of [...new Set(roots.map((root) => path.resolve(root)))].sort()) {
      const entry = fileURLToPath(new URL("../../index.ts", import.meta.url))
      const child = Bun.spawn({
        cmd: existsSync(entry)
          ? [process.execPath, "run", entry, "__storage-maintenance-runner"]
          : [process.execPath, "__storage-maintenance-runner"],
        env: { ...process.env, SYNERGY_HOME: path.dirname(root), SYNERGY_MAINTENANCE_ROOT: root },
        stdout: "ignore",
        stderr: "pipe",
      })
      const error = new Response(child.stderr).text()
      const code = await child.exited
      if (code !== 0) throw new Error(`Data upgrade failed: ${await error}`)
      await error
    }
    return SnapshotArchive.lockHomes(roots)
  }

  function exclude(relative: string, skipped: ReadonlySet<string> = new Set(), packs?: ReadonlySet<string>) {
    const segments = relative.split(path.sep)
    if (archiveExclusions("data").includes(segments[0])) return true
    if (segments[0] === "agent-artifacts" && segments.length > 1 && packs && !packs.has(segments[1])) return true
    if (segments[0] === "sessions" && skipped.has(segments[2] ?? "")) return true
    return Boolean(legacyRecordKey(segments.join("/")))
  }

  async function artifactPacks(handle: Storage.Handle, accept: (key: string[]) => boolean = () => true) {
    return handle.store.snapshot(async (tx) => {
      const packs = new Set<string>()
      for await (const entry of tx.artifacts()) if (accept(entry.key)) packs.add(entry.location.pack)
      return packs
    })
  }

  export async function pack(sourceRoot: string, destination: string) {
    const handle = await StorageBootstrap.inspect(sourceRoot)
    if (!handle) throw new Error("Source storage has not been initialized")
    try {
      await StoragePortable.exportFile(handle.store, path.join(destination, "agent-records.ndjson"))
      await SnapshotArchive.merge(handle.artifactDirectory, destination, { metadata: false })
      const packs = await artifactPacks(handle)
      const result = await copyDirSkipExisting(
        handle.artifactDirectory,
        destination,
        undefined,
        undefined,
        undefined,
        (relative) => exclude(relative, undefined, packs),
      )
      await Storage.validateArtifacts({ store: handle.store, artifactDirectory: destination })
      return result
    } finally {
      await handle.store.close()
    }
  }

  export async function merge(
    sourceRoot: string,
    targetRoot: string,
    options: { progress?: (progress: CopyProgress) => void; trusted?: boolean } = {},
  ) {
    const source = await StorageBootstrap.inspect(sourceRoot)
    if (!source) throw new Error("Source storage has not been initialized")
    let target: StorageBootstrap.Prepared | undefined
    try {
      await StorageCompat.assertConverged(source.store)
      target = await StorageBootstrap.prepare({ root: targetRoot })
      await StorageCompat.assertConverged(target.store)
      const skipped = new Set<string>()
      for (const scopeID of await target.store.scan(["sessions"]))
        for (const id of await target.store.scan(["sessions", scopeID])) skipped.add(id)
      for (const scopeID of await target.store.scan(["snapshot-v2"]))
        for (const id of await target.store.scan(["snapshot-v2", scopeID, "owners"])) skipped.add(id)
      const id = randomUUID()
      const backup = path.join(targetRoot, "data", "storage", "transfers", id)
      // Retain the entire source, including skipped aggregates, before move can remove its home.
      await pack(sourceRoot, path.join(backup, "data"))
      const acceptArtifact = (key: string[]) => {
        const owner = sessionOwner({ key })
        return (
          !local.has(key[0]) &&
          !derived.has(key[0]) &&
          (options.trusted || !authorityRecordRoots.has(key[0])) &&
          (!owner || !skipped.has(owner))
        )
      }
      const packs = await artifactPacks(source, acceptArtifact)
      const copied = await copyDirSkipExisting(
        source.artifactDirectory,
        path.join(targetRoot, "data"),
        options.progress,
        undefined,
        undefined,
        (relative) => exclude(relative, skipped, packs),
      )
      await SnapshotArchive.merge(source.artifactDirectory, path.join(targetRoot, "data"), { metadata: false, skipped })
      await Storage.validateArtifacts(
        { store: source.store, artifactDirectory: path.join(targetRoot, "data") },
        { accept: acceptArtifact },
      )
      const conflicts = new Set<string>()
      const result = await StoragePortable.importFile(target.store, path.join(backup, "data", "agent-records.ndjson"), {
        operationID: id,
        accept: async (entry, tx) => {
          if (entry.type === "event") return false
          if (entry.type === "receipt") return true
          if (local.has(entry.key[0]) || derived.has(entry.key[0])) return false
          // Grants, consent and trust decisions never cross homes through an
          // untrusted merge: an imported approval would silently satisfy the
          // consent prompt for a later plugin install. Same-home relocation
          // (data move) opts in explicitly.
          if (!options.trusted && authorityRecordRoots.has(entry.key[0])) return false
          const owner = sessionOwner(entry)
          if (owner && skipped.has(owner)) {
            conflicts.add(owner)
            return false
          }
          if (entry.type === "artifact") {
            try {
              await tx.artifact(entry.key)
              return false
            } catch (error) {
              if (error instanceof Storage.NotFoundError) return true
              throw error
            }
          }
          return (await tx.readMany([entry.key]))[0] === undefined
        },
        afterImport: async (tx) => {
          await Session.rebuildStorageIndexes(tx)
          await tx.write(["storage_transfer", id], {
            version: 1,
            complete: true,
            skippedSessionIDs: [...conflicts],
            backup: path.relative(targetRoot, backup),
            created: Date.now(),
          })
        },
      })
      await Storage.writeJsonAtomic(
        path.join(backup, "report.json"),
        JSON.stringify({ version: 1, ...result, skippedSessionIDs: [...conflicts] }),
        { private: true, durable: true },
      )
      return { ...copied, skipped: copied.skipped + conflicts.size, skippedSessions: conflicts.size }
    } finally {
      await target?.store.close()
      await source.store.close()
    }
  }
}

function sessionOwner(entry: { key: string[] }): string | undefined {
  const key = entry.key
  if (key[0] === "sessions" || key[0].startsWith("session_search_") || key[0] === "session_message_order_v1")
    return key[2]
  if (key[0] === "snapshot-v2" && ["owners", "migrations", "deletions"].includes(key[2])) return key[3]
  if (key[0] === "storage_recovery" && key[1] === "sessions") return key[2]
}

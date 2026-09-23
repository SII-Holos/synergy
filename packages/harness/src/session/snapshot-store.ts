import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Context } from "../util/context"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import type { SnapshotSchema } from "./snapshot-schema"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotProtection } from "./snapshot-protection"
import { Log } from "../util/log"

export namespace SnapshotStore {
  const log = Log.create({ service: "snapshot-store" })
  export const Owner = z.object({ version: z.literal(2), backend: z.enum(["legacy", "shared", "deleted"]) })
  export type Owner = z.infer<typeof Owner>
  export const OID = /^[0-9a-f]{40}$/
  export interface Operation {
    scopeID: string
    sessionID: string
    backend: "legacy" | "shared"
    repository: string
    index: string
    temporary: string
    workspace: string
  }
  const context = Context.create<Operation>("snapshot")

  export class StorageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options)
      this.name = "SnapshotStorageError"
    }
  }

  export function component(value: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new StorageError("Invalid snapshot owner")
    return value
  }

  export function root(scopeID: string) {
    return path.join(Storage.current().artifactDirectory, "snapshot-v2", component(scopeID))
  }

  export function repository(scopeID: string) {
    return path.join(root(scopeID), "store.git")
  }

  export function legacyRepository(scopeID: string, sessionID: string) {
    return path.join(
      path.join(Storage.current().artifactDirectory, "snapshot"),
      component(scopeID),
      component(sessionID),
    )
  }

  export function cache(scopeID: string, sessionID?: string) {
    return path.join(
      Global.Path.cache,
      "snapshot-index",
      createHash("sha256").update(Storage.current().artifactDirectory).digest("hex").slice(0, 16),
      component(scopeID),
      ...(sessionID ? [component(sessionID)] : []),
    )
  }

  export async function optional<T>(key: string[]): Promise<T | undefined> {
    return Storage.read<T>(key, { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export function write<T>(key: string[], value: T) {
    return Storage.write(key, value)
  }

  export async function owner(scopeID: string, sessionID: string) {
    component(scopeID)
    component(sessionID)
    const stored = await optional<unknown>(StoragePath.snapshotOwner(scopeID, sessionID))
    return stored === undefined ? undefined : Owner.parse(stored)
  }

  export async function resolveRepository(scopeID: string, sessionID: string) {
    const record = await owner(scopeID, sessionID)
    if (record?.backend === "deleted") throw new StorageError("Snapshot session has been permanently deleted")
    const backend = record?.backend ?? "shared"
    return {
      scopeID,
      sessionID,
      backend,
      repository: backend === "legacy" ? legacyRepository(scopeID, sessionID) : repository(scopeID),
    }
  }

  export async function resolve(
    scopeID: string,
    sessionID: string,
    workspace: string,
    source?: SnapshotSchema.Workspace,
  ): Promise<Operation> {
    const owned = await resolveRepository(scopeID, sessionID)
    const { backend, repository: repo } = owned
    const real = await fs.realpath(workspace).catch(() => path.resolve(workspace))
    const identity = source
      ? JSON.stringify([source.id, source.generation])
      : process.platform === "win32"
        ? real.toLowerCase()
        : real
    const temporary = path.join(cache(scopeID, sessionID), createHash("sha256").update(identity).digest("hex"))
    return {
      scopeID,
      sessionID,
      backend,
      repository: repo,
      workspace,
      index: backend === "legacy" ? path.join(repo, "index") : path.join(temporary, "index"),
      temporary,
    }
  }

  export function current() {
    return context.use()
  }

  export async function withSession<T>(
    sessionID: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    options?: { historical?: boolean },
  ) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    // Bun 1.3.14 cancels a timeout signal when its last listener is removed. Keep
    // this operation's listener through Git, native admission and final cleanup.
    signal?.addEventListener("abort", forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    try {
      return await withSessionImpl(sessionID, fn, signal ? controller.signal : undefined, options)
    } finally {
      signal?.removeEventListener("abort", forwardAbort)
    }
  }

  async function withSessionImpl<T>(
    sessionID: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    options?: { historical?: boolean },
  ) {
    const scopeID = ScopeContext.current.scope.id
    component(sessionID)
    if (
      (await owner(scopeID, sessionID))?.backend === "legacy" &&
      (await SnapshotProtection.active(Storage.current().artifactDirectory))
    ) {
      const { SnapshotMaintenance } = await import("./snapshot-maintenance")
      const result = await SnapshotMaintenance.migrate(scopeID, { apply: true, sessionID, signal })
      if (result.results.some((result) => result.status !== "migrated"))
        throw new StorageError("Protected historical snapshots are not ready")
    }
    return SnapshotLease.use(
      scopeID,
      false,
      () =>
        withFileLock(
          { directory: SnapshotLease.directory(), key: `snapshot-session:${scopeID}:${sessionID}`, signal },
          async () => {
            signal?.throwIfAborted()
            const workspace = options?.historical ? undefined : ScopeContext.current.workspace
            const source =
              workspace?.id && workspace.generation
                ? { id: workspace.id, generation: workspace.generation, root: workspace.path }
                : undefined
            const operation = await resolve(
              scopeID,
              sessionID,
              options?.historical ? path.dirname(repository(scopeID)) : ScopeContext.current.directory,
              source,
            )
            await fs.mkdir(operation.temporary, { recursive: true })
            return context.provide(operation, fn)
          },
        ),
      { signal },
    )
  }

  export async function command(repo: string, args: string[], signal?: AbortSignal, stdin?: string) {
    const result = await SnapshotGit.run(
      ["git", "--git-dir", repo, ...args],
      path.dirname(repo),
      undefined,
      signal,
      stdin,
    )
    if (result.exitCode !== 0)
      throw new StorageError(`Snapshot git ${args[0]} failed (exit code ${result.exitCode}): ${result.stderr.trim()}`, {
        cause: { exitCode: result.exitCode, stderr: result.stderr },
      })
    return result.text.trim()
  }

  export async function initialize(operation: Awaited<ReturnType<typeof resolveRepository>>) {
    await withFileLock(
      { directory: SnapshotLease.directory(), key: `snapshot-init:${operation.repository}` },
      async () => {
        if (operation.backend === "legacy") {
          await SnapshotProtection.assertWritable(Storage.current().artifactDirectory)
          if (!(await Bun.file(path.join(operation.repository, "HEAD")).exists()))
            throw new StorageError("Legacy snapshot repository is missing")
          return
        }
        await initializeRepository(operation.scopeID)
        await Storage.transaction(async () => {
          const current = await owner(operation.scopeID, operation.sessionID)
          if (current?.backend === "deleted") throw new StorageError("Session snapshot ownership was deleted")
          if (!current)
            await write(StoragePath.snapshotOwner(operation.scopeID, operation.sessionID), {
              version: 2,
              backend: "shared",
            } satisfies Owner)
        })
      },
    )
  }

  export async function initializeRepository(scopeID: string) {
    const repo = repository(scopeID)
    const initialized = await optional<unknown>(StoragePath.snapshotRepository(scopeID))
    if (initialized !== undefined) {
      z.object({ version: z.literal(2), objectFormat: z.literal("sha1") }).parse(initialized)
      if (!(await Bun.file(path.join(repo, "HEAD")).exists()))
        throw new StorageError("Snapshot object store is missing")
      await assertStandalone(repo)
      return
    }
    await assertStandalone(repo)
    await initializeBareRepository(repo)
    await write(StoragePath.snapshotRepository(scopeID), { version: 2, objectFormat: "sha1" })
  }

  export async function assertStandalone(repo: string) {
    if (await Bun.file(path.join(repo, "objects", "info", "alternates")).exists())
      throw new StorageError("Shared snapshots have an external object dependency")
  }

  export async function initializeBareRepository(repo: string) {
    await fs.mkdir(path.dirname(repo), { recursive: true })
    if (!(await Bun.file(path.join(repo, "HEAD")).exists())) {
      // Provenance: https://git-scm.com/docs/git-init (GIT_DEFAULT_HASH).
      // Git before 2.29 only writes SHA-1; the environment also pins newer Git
      // without requiring the newer --object-format command-line option.
      const init = await SnapshotGit.run(["git", "init", "--bare", repo], path.dirname(repo), {
        GIT_DEFAULT_HASH: "sha1",
      })
      if (init.exitCode !== 0)
        throw new StorageError(
          `Unable to initialize snapshot object store (exit code ${init.exitCode}): ${init.stderr.trim()}`,
          { cause: { exitCode: init.exitCode, stderr: init.stderr } },
        )
    }
    const hash = await command(repo, ["hash-object", "-t", "tree", "--stdin"])
    if (!OID.test(hash)) throw new StorageError("Snapshot object store must use SHA-1")
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.quotepath", "false"],
      ["gc.auto", "0"],
      ["maintenance.auto", "false"],
      ["core.logAllRefUpdates", "false"],
      ["core.fsync", "objects,reference,pack-metadata"],
      ["core.fsyncMethod", "fsync"],
    ])
      await command(repo, ["config", key, value])
  }

  export function reference(sessionID: string, hash: string) {
    component(sessionID)
    if (!OID.test(hash)) throw new StorageError("Invalid snapshot object ID")
    return `refs/synergy/snapshots/${sessionID}/${hash}`
  }

  export async function owns(scopeID: string, sessionID: string, hash: string) {
    if (!OID.test(hash)) return false
    const record = await owner(scopeID, sessionID)
    if (record?.backend === "deleted") return false
    const repo = record?.backend === "legacy" ? legacyRepository(scopeID, sessionID) : repository(scopeID)
    if (!(await Bun.file(path.join(repo, "HEAD")).exists())) return false
    const args =
      record?.backend === "legacy" ? ["cat-file", "-t", hash] : ["rev-parse", "--verify", reference(sessionID, hash)]
    const result = await SnapshotGit.run(["git", "--git-dir", repo, ...args], path.dirname(repo))
    return result.exitCode === 0 && result.text.trim() === (record?.backend === "legacy" ? "tree" : hash)
  }

  // Batched ownership check: one git subprocess answers the whole hash set
  // instead of one process per hash, so callers looping over fork or export
  // candidates stop paying spawn latency per snapshot step.
  export async function ownsMany(scopeID: string, sessionID: string, hashes: string[]) {
    const owned = new Set<string>()
    const valid = hashes.filter((hash) => OID.test(hash))
    if (!valid.length) return owned
    const record = await owner(scopeID, sessionID)
    if (record?.backend === "deleted") return owned
    const legacy = record?.backend === "legacy"
    const repo = legacy ? legacyRepository(scopeID, sessionID) : repository(scopeID)
    if (!(await Bun.file(path.join(repo, "HEAD")).exists())) return owned
    if (legacy) {
      // Provenance: https://git-scm.com/docs/git-cat-file (BATCH OUTPUT).
      // A missing object reports as a "missing" batch line rather than an
      // error exit, and the type column carries the same answer as cat-file -t.
      const input = valid.map((hash) => `${hash}\n`).join("")
      const text = await command(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], undefined, input)
      const types = new Map<string, string>()
      for (const line of text.split("\n")) {
        const [objectname, objecttype] = line.trim().split(" ")
        if (objectname && objecttype) types.set(objectname, objecttype)
      }
      for (const hash of valid) if (types.get(hash) === "tree") owned.add(hash)
      return owned
    }
    const prefix = `refs/synergy/snapshots/${component(sessionID)}/`
    const requested = new Set(valid)
    const text = await command(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])
    for (const line of text.split("\n")) {
      const [ref, hash] = line.trim().split(" ")
      if (requested.has(hash) && ref === reference(sessionID, hash)) owned.add(hash)
    }
    return owned
  }

  export function ownsCurrent(hash: string) {
    const operation = current()
    return owns(operation.scopeID, operation.sessionID, hash)
  }

  // Provenance: https://docs.jj-vcs.dev/latest/technical/architecture/#gitbackend
  // Local adaptation: retain each session's tree before publishing its hash;
  // GC must see every historical root, not just the newest tree or reflog.
  export async function retainCurrent(hash: string, signal?: AbortSignal) {
    const operation = current()
    if (operation.backend === "legacy") return true
    const result = await SnapshotGit.run(
      ["git", "--git-dir", operation.repository, "update-ref", reference(operation.sessionID, hash), hash],
      operation.workspace,
      undefined,
      signal,
    )
    if (result.exitCode !== 0)
      log.warn("snapshot retention failed", { exitCode: result.exitCode, stderr: result.stderr })
    return result.exitCode === 0
  }

  // Batched retention write: one update-ref --stdin process records every
  // retained tree under the same refs as the single-hash retainCurrent path.
  export async function retainMany(scopeID: string, sessionID: string, hashes: string[]) {
    const updates: string[] = []
    for (const hash of new Set(hashes)) {
      if (!OID.test(hash)) continue
      updates.push(`update ${reference(sessionID, hash)} ${hash}`)
    }
    if (!updates.length) return
    await command(repository(scopeID), ["update-ref", "--stdin"], undefined, `${updates.join("\n")}\n`)
  }
}

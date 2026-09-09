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
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"

export namespace SnapshotStore {
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
    return path.join(Global.Path.data, "snapshot-v2", component(scopeID))
  }

  export function repository(scopeID: string) {
    return path.join(root(scopeID), "store.git")
  }

  export function legacyRepository(scopeID: string, sessionID: string) {
    return path.join(Global.Path.snapshot, component(scopeID), component(sessionID))
  }

  export function cache(scopeID: string, sessionID?: string) {
    return path.join(
      Global.Path.cache,
      "snapshot-index",
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
    return Storage.write(key, value, { durable: true })
  }

  export async function owner(scopeID: string, sessionID: string) {
    component(scopeID)
    component(sessionID)
    const stored = await optional<unknown>(StoragePath.snapshotOwner(scopeID, sessionID))
    return stored === undefined ? undefined : Owner.parse(stored)
  }

  export async function resolve(scopeID: string, sessionID: string, workspace: string): Promise<Operation> {
    const record = await owner(scopeID, sessionID)
    if (record?.backend === "deleted") throw new StorageError("Snapshot session has been permanently deleted")
    const backend = record?.backend ?? "shared"
    const repo = backend === "legacy" ? legacyRepository(scopeID, sessionID) : repository(scopeID)
    const real = await fs.realpath(workspace).catch(() => path.resolve(workspace))
    const identity = process.platform === "win32" ? real.toLowerCase() : real
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

  export async function withSession<T>(sessionID: string, fn: () => Promise<T>, signal?: AbortSignal) {
    const scopeID = ScopeContext.current.scope.id
    component(sessionID)
    return SnapshotLease.use(
      scopeID,
      false,
      () =>
        withFileLock(
          { directory: SnapshotLease.directory(), key: `snapshot-session:${scopeID}:${sessionID}` },
          async () => {
            signal?.throwIfAborted()
            const operation = await resolve(scopeID, sessionID, ScopeContext.current.directory)
            await fs.mkdir(operation.temporary, { recursive: true })
            return context.provide(operation, fn)
          },
        ),
      { signal },
    )
  }

  export async function command(repo: string, args: string[], signal?: AbortSignal) {
    const result = await SnapshotGit.run(["git", "--git-dir", repo, ...args], path.dirname(repo), undefined, signal)
    if (result.exitCode !== 0)
      throw new StorageError(`Snapshot git ${args[0]} failed (exit code ${result.exitCode}): ${result.stderr.trim()}`, {
        cause: { exitCode: result.exitCode, stderr: result.stderr },
      })
    return result.text.trim()
  }

  export async function initialize(operation: Operation) {
    await withFileLock(
      { directory: SnapshotLease.directory(), key: `snapshot-init:${operation.repository}` },
      async () => {
        if (operation.backend === "legacy") {
          if (!(await Bun.file(path.join(operation.repository, "HEAD")).exists()))
            throw new StorageError("Legacy snapshot repository is missing")
          return
        }
        await initializeRepository(operation.scopeID)
        if (!(await owner(operation.scopeID, operation.sessionID))) {
          await write(StoragePath.snapshotOwner(operation.scopeID, operation.sessionID), {
            version: 2,
            backend: "shared",
          } satisfies Owner)
        }
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
    return result.exitCode === 0
  }
}

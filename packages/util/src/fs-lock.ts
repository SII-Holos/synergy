import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { processStartIdentity } from "./process-identity"

export interface FileLockOptions {
  directory: string
  key: string
  retryMs?: number
  timeoutMs?: number
  staleMetadataMs?: number
  timeoutMessage?: string
}

const DEFAULT_RETRY_MS = 25
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_STALE_METADATA_MS = 5_000
const VERIFIED_LIVE_TTL_MS = 1_000

export const HOLOS_ACCOUNTS_WRITE_LOCK_KEY = "holos-accounts:write"
export const LEGACY_API_KEY_WRITE_LOCK_KEY = "legacy-api-key:write"

export function authLockDirectory(synergyRoot: string): string {
  return path.join(synergyRoot, "data", "auth", ".locks")
}

export function fileLockPath(directory: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex")
  return path.join(directory, `${digest}.lock`)
}

export async function withFileLock<T>(options: FileLockOptions, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(options)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

interface LockOwner {
  pid?: number
  startIdentity?: string
}

interface OwnerSnapshot {
  contents: string
  owner?: LockOwner
}

async function acquireFileLock(options: FileLockOptions): Promise<{ release(): Promise<void> }> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMetadataMs = options.staleMetadataMs ?? DEFAULT_STALE_METADATA_MS
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
  await fs.chmod(options.directory, 0o700)
  const filename = fileLockPath(options.directory, options.key)
  const startedAt = Date.now()
  const startIdentity = await processStartIdentity(process.pid)
  const ownerToken = randomUUID()
  const verifiedLiveUntil = new Map<string, number>()

  while (true) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(options.timeoutMessage ?? `Timed out acquiring file lock for ${options.key}`)
    }
    try {
      const handle = await fs.open(filename, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), startIdentity, ownerToken }))
      } catch (error) {
        await fs.unlink(filename).catch(() => {})
        throw error
      } finally {
        await handle.close()
      }
      return {
        release: () => releaseOwnedLock(filename, ownerToken),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const snapshot = await readOwnerSnapshot(filename)
      if (snapshot && (await isStaleOwner(filename, snapshot, staleMetadataMs, verifiedLiveUntil))) {
        if (await removeStaleLock(filename, snapshot.contents)) continue
      }
      await sleep(retryMs)
    }
  }
}

async function readOwnerSnapshot(filename: string): Promise<OwnerSnapshot | undefined> {
  const contents = await fs.readFile(filename, "utf8").catch(() => undefined)
  if (contents === undefined) return undefined
  try {
    const value = JSON.parse(contents) as unknown
    if (!value || typeof value !== "object") return { contents }
    const pid = (value as { pid?: unknown }).pid
    const startIdentity = (value as { startIdentity?: unknown }).startIdentity
    return {
      contents,
      owner: {
        pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined,
        startIdentity: typeof startIdentity === "string" ? startIdentity : undefined,
      },
    }
  } catch {
    return { contents }
  }
}

/**
 * A live pid proves nothing: pids recycle on every platform, and on Windows a
 * recycled pid makes a dead owner look alive forever. The recorded start
 * identity settles whether the pid still belongs to the process that took the
 * lock — deterministically, without ever displacing a live owner by age.
 */
async function isStaleOwner(
  filename: string,
  snapshot: OwnerSnapshot,
  staleMetadataMs: number,
  verifiedLiveUntil: Map<string, number>,
): Promise<boolean> {
  const owner = snapshot.owner
  if (owner?.pid === undefined) {
    const stat = await fs.stat(filename).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > staleMetadataMs
  }
  if (!processExists(owner.pid)) return true
  if (owner.startIdentity === undefined) return false
  const key = `${owner.pid}:${owner.startIdentity}`
  const verifiedUntil = verifiedLiveUntil.get(key)
  if (verifiedUntil !== undefined && verifiedUntil > Date.now()) return false
  const current = await processStartIdentity(owner.pid)
  if (current === undefined || current === owner.startIdentity) {
    // The owner was verified live. Cache the verdict briefly so the identity
    // query (a subprocess on Windows) is not spawned on every retry, but
    // recheck once it expires: the owner may exit and its pid be recycled
    // while this acquisition attempt is still waiting.
    verifiedLiveUntil.set(key, Date.now() + VERIFIED_LIVE_TTL_MS)
    return false
  }
  return true
}

/**
 * Remove the lock file only while its contents still match the snapshot the
 * stale decision was based on. Read-compare-unlink, never rename-vacate: a
 * rename briefly removes the canonical path, and when several waiters observe
 * the same stale payload a delayed rename can displace a successor's fresh
 * lock and then discard it on a failed restore — overlapping critical
 * sections. The residual read-to-unlink window is far narrower and only
 * deletes a lock that was replaced in that instant, not a lock we moved.
 */
async function removeStaleLock(filename: string, expectedContents: string): Promise<boolean> {
  const current = await fs.readFile(filename, "utf8").catch(() => undefined)
  if (current !== expectedContents) return false
  try {
    await fs.unlink(filename)
    return true
  } catch (error) {
    // ENOENT: another waiter already reclaimed it — treat as removed.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

async function releaseOwnedLock(filename: string, ownerToken: string): Promise<void> {
  const contents = await fs.readFile(filename, "utf8").catch(() => undefined)
  if (contents === undefined || readOwnerToken(contents) !== ownerToken) return
  try {
    await fs.unlink(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function readOwnerToken(contents: string | undefined): string | undefined {
  if (contents === undefined) return undefined
  try {
    const value = JSON.parse(contents) as unknown
    if (!value || typeof value !== "object") return undefined
    const ownerToken = (value as { ownerToken?: unknown }).ownerToken
    return typeof ownerToken === "string" ? ownerToken : undefined
  } catch {
    return undefined
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

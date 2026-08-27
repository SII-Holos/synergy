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
  const verifiedLive = new Set<string>()

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
      if (snapshot && (await isStaleOwner(filename, snapshot, staleMetadataMs, verifiedLive))) {
        if (await removeLockIfUnchanged(filename, snapshot.contents)) continue
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
  verifiedLive: Set<string>,
): Promise<boolean> {
  const owner = snapshot.owner
  if (owner?.pid === undefined) {
    const stat = await fs.stat(filename).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > staleMetadataMs
  }
  if (!processExists(owner.pid)) return true
  if (owner.startIdentity === undefined) return false
  const key = `${owner.pid}:${owner.startIdentity}`
  if (verifiedLive.has(key)) return false
  const current = await processStartIdentity(owner.pid)
  if (current === undefined || current === owner.startIdentity) {
    verifiedLive.add(key)
    return false
  }
  return true
}

/**
 * Remove the lock file only while its contents still match the snapshot the
 * stale decision was based on, so a concurrently recreated lock is never
 * deleted by a stale verdict.
 */
async function removeLockIfUnchanged(filename: string, expectedContents: string): Promise<boolean> {
  const quarantinePath = `${filename}.stale-${randomUUID()}`
  try {
    await fs.rename(filename, quarantinePath)
  } catch {
    return false
  }
  const quarantined = await fs.readFile(quarantinePath, "utf8").catch(() => undefined)
  if (quarantined !== expectedContents) {
    await restoreQuarantined(quarantinePath, filename)
    return false
  }
  await fs.rm(quarantinePath, { force: true }).catch(() => {})
  return true
}

async function releaseOwnedLock(filename: string, ownerToken: string): Promise<void> {
  const quarantinePath = `${filename}.release-${randomUUID()}`
  try {
    await fs.rename(filename, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return
  }
  const contents = await fs.readFile(quarantinePath, "utf8").catch(() => undefined)
  const owner = readOwnerToken(contents)
  if (owner === ownerToken) {
    await fs.rm(quarantinePath, { force: true }).catch(() => {})
    return
  }
  await restoreQuarantined(quarantinePath, filename)
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

async function restoreQuarantined(quarantinePath: string, filename: string): Promise<void> {
  try {
    await fs.rename(quarantinePath, filename)
  } catch {
    // A newer owner already recreated the lock file; the quarantined payload
    // is obsolete and safe to drop.
    await fs.rm(quarantinePath, { force: true }).catch(() => {})
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

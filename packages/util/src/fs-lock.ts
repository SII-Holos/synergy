import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

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

async function acquireFileLock(options: FileLockOptions): Promise<{ release(): Promise<void> }> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMetadataMs = options.staleMetadataMs ?? DEFAULT_STALE_METADATA_MS
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
  await fs.chmod(options.directory, 0o700)
  const filename = fileLockPath(options.directory, options.key)
  const startedAt = Date.now()

  while (true) {
    try {
      const handle = await fs.open(filename, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
      } catch (error) {
        await fs.unlink(filename).catch(() => {})
        throw error
      } finally {
        await handle.close()
      }
      return {
        async release() {
          await fs.unlink(filename).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = await readLockOwner(filename)
      if (await isLockReclaimable(filename, owner, staleMetadataMs)) {
        await fs.unlink(filename).catch(() => {})
        continue
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(options.timeoutMessage ?? `Timed out acquiring file lock for ${options.key}`)
      }
      await sleep(retryMs)
    }
  }
}

async function readLockOwner(filename: string): Promise<{ pid?: number; acquiredAt?: number } | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(filename, "utf8")) as unknown
    if (!owner || typeof owner !== "object") return undefined
    const pid = (owner as { pid?: unknown }).pid
    const acquiredAt = (owner as { acquiredAt?: unknown }).acquiredAt
    return {
      pid: typeof pid === "number" ? pid : undefined,
      acquiredAt: typeof acquiredAt === "number" ? acquiredAt : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Decide whether an existing lock can be reclaimed (unlinked and retried).
 *
 * Reclaim when the owner is provably gone, or when the lock metadata has aged
 * past `staleMetadataMs`. On Windows, PIDs recycle aggressively and
 * `process.kill(pid, 0)` returns true for a recycled PID that now belongs to
 * an unrelated live process — so a dead owner's lock would otherwise never be
 * reclaimed and every later acquirer would spin to the timeout. There, the
 * wall-clock age (acquiredAt, with an mtime fallback) is the tiebreaker: a
 * lock older than the grace period is treated as stale even if its PID looks
 * live. On posix the PID check is reliable, so a genuinely-live owner is never
 * displaced by age alone.
 */
async function isLockReclaimable(
  filename: string,
  owner: { pid?: number; acquiredAt?: number } | undefined,
  staleMetadataMs: number,
): Promise<boolean> {
  // No owner PID at all: fall back to the lock file's mtime, as the metadata
  // is either missing or unreadable.
  if (!owner?.pid) {
    const stat = await fs.stat(filename).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > staleMetadataMs
  }
  // Owner PID recorded and provably dead → safe to reclaim on every platform.
  if (!processExists(owner.pid)) return true
  // On Windows the live-PID signal is unreliable (recycling). Reclaim if the
  // lock is older than the grace period, using acquiredAt when the owner wrote
  // it (preferred over mtime, which AV/indexers can touch) with mtime fallback.
  if (process.platform === "win32") {
    const ageMs = owner.acquiredAt != null ? Date.now() - owner.acquiredAt : await lockFileAgeMs(filename)
    if (ageMs > staleMetadataMs) return true
  }
  return false
}

async function lockFileAgeMs(filename: string): Promise<number> {
  const stat = await fs.stat(filename).catch(() => undefined)
  return stat ? Date.now() - stat.mtimeMs : 0
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

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
      if (owner?.pid && !processExists(owner.pid)) {
        await fs.unlink(filename).catch(() => {})
        continue
      }
      if (!owner?.pid) {
        const stat = await fs.stat(filename).catch(() => undefined)
        if (stat && Date.now() - stat.mtimeMs > staleMetadataMs) {
          await fs.unlink(filename).catch(() => {})
          continue
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(options.timeoutMessage ?? `Timed out acquiring file lock for ${options.key}`)
      }
      await sleep(retryMs)
    }
  }
}

async function readLockOwner(filename: string): Promise<{ pid?: number } | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(filename, "utf8")) as unknown
    if (!owner || typeof owner !== "object") return undefined
    const pid = (owner as { pid?: unknown }).pid
    return typeof pid === "number" ? { pid } : undefined
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

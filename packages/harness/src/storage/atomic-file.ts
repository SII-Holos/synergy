import path from "node:path"
import fs from "node:fs/promises"
import { isRetryableIOError } from "../util/io-retry"

export namespace AtomicFile {
  export interface WriteOptions {
    durable?: boolean
    private?: boolean
  }
  // Windows maps rename onto MoveFileEx: when another process (antivirus,
  // OneDrive, a cross-process reader of these JSON files) briefly holds a
  // handle on the source or target without FILE_SHARE_DELETE, the rename
  // fails with EPERM/EACCES. Sharing violations clear within milliseconds,
  // so retry the whole write+rename sequence with short backoff instead of
  // failing session persistence and terminating the owning session (#1247).
  const ATOMIC_WRITE_ATTEMPTS = 4
  const ATOMIC_WRITE_RETRY_BASE_MS = 50
  const ATOMIC_WRITE_RETRY_MAX_MS = 200

  export async function writeJsonAtomic(target: string, serialized: string, options?: WriteOptions) {
    return writeFileAtomic(target, serialized, options)
  }

  export async function writeFileAtomic(target: string, content: string | Uint8Array, options?: WriteOptions) {
    await fs.mkdir(path.dirname(target), { recursive: true, ...(options?.private ? { mode: 0o700 } : {}) })
    const tmp = path.join(
      path.dirname(target),
      `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    )
    for (let attempt = 1; ; attempt++) {
      try {
        if (options?.private || options?.durable) {
          const file = await fs.open(tmp, "w", options.private ? 0o600 : 0o666)
          try {
            await file.writeFile(content)
            if (options.durable) await file.sync()
          } finally {
            await file.close()
          }
        } else {
          await Bun.write(tmp, content)
        }
        await fs.rename(tmp, target)
        if (options?.durable && process.platform !== "win32") {
          const directory = await fs.open(path.dirname(target), "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
        return
      } catch (error) {
        if (!isRetryableIOError(error) || attempt >= ATOMIC_WRITE_ATTEMPTS) {
          await removeTempFile(tmp)
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, atomicRetryDelayMs(attempt)))
      }
    }
  }

  // The terminal-failure cleanup can hit the same Windows sharing violation
  // that failed the rename (antivirus holding the temp handle), so transient
  // unlink errors retry with the same backoff before being suppressed (#1247).
  async function removeTempFile(tmp: string) {
    for (let attempt = 1; attempt <= ATOMIC_WRITE_ATTEMPTS; attempt++) {
      try {
        await fs.unlink(tmp)
        return
      } catch (error) {
        if (!isRetryableIOError(error) || attempt >= ATOMIC_WRITE_ATTEMPTS) return
        await new Promise((resolve) => setTimeout(resolve, atomicRetryDelayMs(attempt)))
      }
    }
  }

  function atomicRetryDelayMs(attempt: number) {
    return Math.min(ATOMIC_WRITE_RETRY_MAX_MS, ATOMIC_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1))
  }
}

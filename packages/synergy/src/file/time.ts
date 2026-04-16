import { Instance } from "../scope/instance"
import { Log } from "../util/log"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: Date | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function read(sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = new Date()
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  export async function withLock<T>(
    filepath: string,
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)

    // Wait for the previous lock, but abort if signal fires.
    // On abort, remove our chained entry so subsequent callers don't deadlock.
    if (options?.signal?.aborted) {
      if (current.locks.get(filepath) === chained) current.locks.delete(filepath)
      throw new DOMException("Aborted", "AbortError")
    }
    const abortPromise = options?.signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => {
            if (current.locks.get(filepath) === chained) current.locks.delete(filepath)
            reject(new DOMException("Aborted", "AbortError"))
          }
          options.signal!.addEventListener("abort", onAbort, { once: true })
        })
      : null
    try {
      await (abortPromise ? Promise.race([currentLock, abortPromise]) : currentLock)
    } catch (error) {
      release()
      throw error
    }

    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(sessionID: string, filepath: string) {
    const time = get(sessionID, filepath)
    if (!time) throw new Error(`You must read the file ${filepath} before overwriting it. Use the Read tool first`)
    const stats = await Bun.file(filepath).stat()
    if (stats.mtime.getTime() > time.getTime()) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${stats.mtime.toISOString()}\nLast read: ${time.toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
  }
}

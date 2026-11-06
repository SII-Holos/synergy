import { createHash } from "node:crypto"
import { WorkspaceState } from "../workspace/state"
import { formatLocalDateTime } from "../util/time-format"
import { Lock } from "../util/lock"
import { Log } from "../util/log"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  export const state = WorkspaceState.create(() => ({
    read: new Map<string, Map<string, { at: Date; version?: string }>>(),
  }))

  export function version(content: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`
  }

  export function read(sessionID: string, file: string, content?: string | Uint8Array) {
    log.info("read", { sessionID, file })
    const current = state()
    let files = current.read.get(sessionID)
    if (!files) current.read.set(sessionID, (files = new Map()))
    files.set(file, { at: new Date(), version: content === undefined ? undefined : version(content) })
  }

  export function get(sessionID: string, file: string) {
    return state().read.get(sessionID)?.get(file)?.at
  }

  export async function withLock<T>(
    filepath: string,
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const key = JSON.stringify([WorkspaceState.key(), "file", filepath])
    using lock = options?.signal ? await Lock.writeWithSignal(key, options.signal) : await Lock.write(key)
    if (!lock || options?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
    return await fn()
  }

  export function assert(sessionID: string, filepath: string, content: string | Uint8Array) {
    const evidence = state().read.get(sessionID)?.get(filepath)
    if (!evidence?.version)
      throw new Error(`You must read the file ${filepath} before overwriting it. Use the Read tool first`)
    if (evidence.version !== version(content)) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast read: ${formatLocalDateTime(evidence.at.getTime())}\n\nPlease read the file again before modifying it.`,
      )
    }
  }
}

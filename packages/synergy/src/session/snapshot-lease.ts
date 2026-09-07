import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { processStartIdentity } from "@ericsanchezok/synergy-util/process-identity"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Global } from "../global"

export namespace SnapshotLease {
  const Owner = z.object({
    token: z.string(),
    pid: z.number().int().positive(),
    identity: z.string().optional(),
    exclusive: z.boolean(),
  })
  const State = z.object({ owners: z.array(Owner) })
  type Owner = z.infer<typeof Owner>

  export class BusyError extends Error {
    constructor() {
      super("Snapshot storage is busy; retry after the current operation completes")
      this.name = "SnapshotStorageBusyError"
    }
  }

  export function directory(dataRoot = Global.Path.data) {
    return path.join(dataRoot, "snapshot-v2", ".locks")
  }

  async function alive(owner: Owner) {
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
    if (!owner.identity) return true
    const current = await processStartIdentity(owner.pid)
    return current === undefined || current === owner.identity
  }

  async function update<T>(dataRoot: string, scopeID: string, fn: (state: z.infer<typeof State>) => T | Promise<T>) {
    return withFileLock(
      { directory: directory(dataRoot), key: `snapshot-leases:${scopeID}`, timeoutMs: 1000 },
      async () => {
        const file =
          path.join(dataRoot, ...(scopeID ? StoragePath.snapshotLeases(scopeID) : StoragePath.snapshotHomeLeases())) +
          ".json"
        const stored: unknown = await Bun.file(file)
          .json()
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return { owners: [] }
            throw error
          })
        const state = State.parse(stored)
        const before = JSON.stringify(state)
        const living = await Promise.all(state.owners.map(alive))
        state.owners = state.owners.filter((_, index) => living[index])
        const result = await fn(state)
        if (JSON.stringify(state) !== before) await Storage.writeJsonAtomic(file, JSON.stringify(state))
        return result
      },
    )
  }

  interface Options {
    signal?: AbortSignal
    timeoutMs?: number
    dataRoot?: string
  }

  export async function use<T>(
    scopeID: string,
    exclusive: boolean,
    fn: () => Promise<T>,
    options: Options = {},
  ): Promise<T> {
    await using lease = await acquire(scopeID, exclusive, options)
    return await fn()
  }

  // Provenance: https://restic.readthedocs.io/en/stable/100_references.html#locks
  // Local adaptation: a file-locked admission gate prevents reader/pruner races;
  // process start identities, not lease age, determine abandoned ownership.
  export async function acquire(scopeID: string, exclusive: boolean, options: Options = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scopeID)) throw new Error("Invalid snapshot lease Scope")
    const dataRoot = options.dataRoot ?? Global.Path.data
    const home = await admit("", false, { ...options, dataRoot })
    try {
      const scope = await admit(scopeID, exclusive, { ...options, dataRoot })
      return {
        async [Symbol.asyncDispose]() {
          try {
            await scope[Symbol.asyncDispose]()
          } finally {
            await home[Symbol.asyncDispose]()
          }
        },
      }
    } catch (error) {
      await home[Symbol.asyncDispose]()
      throw error
    }
  }

  export function acquireHome(dataRoot: string, options: Omit<Options, "dataRoot"> = {}) {
    return admit("", true, { ...options, dataRoot })
  }

  async function admit(scopeID: string, exclusive: boolean, options: Options) {
    const dataRoot = options.dataRoot ?? Global.Path.data
    const owner: Owner = {
      token: randomUUID(),
      pid: process.pid,
      identity: await processStartIdentity(process.pid),
      exclusive,
    }
    const deadline = Date.now() + (options.timeoutMs ?? 15_000)
    let registered = false
    const release = async () => {
      if (!registered) return
      const file =
        path.join(dataRoot, ...(scopeID ? StoragePath.snapshotLeases(scopeID) : StoragePath.snapshotHomeLeases())) +
        ".json"
      if (!(await Bun.file(file).exists())) {
        registered = false
        return
      }
      await update(dataRoot, scopeID, (state) => {
        state.owners = state.owners.filter((entry) => entry.token !== owner.token)
      })
      registered = false
    }
    try {
      for (;;) {
        options.signal?.throwIfAborted()
        const ready = await update(dataRoot, scopeID, (state) => {
          if (!registered && !state.owners.some((entry) => entry.exclusive)) {
            state.owners.push(owner)
            registered = true
          }
          return registered && (!exclusive || state.owners.length === 1)
        })
        if (ready) break
        if (Date.now() >= deadline) throw new BusyError()
        await pause(options.signal)
      }
      options.signal?.throwIfAborted()
      return { [Symbol.asyncDispose]: release }
    } catch (error) {
      await release()
      throw error
    }
  }

  async function pause(signal?: AbortSignal) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        finish()
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        finish()
        resolve()
      }, 25)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }
}

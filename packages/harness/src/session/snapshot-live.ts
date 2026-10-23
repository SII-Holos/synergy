import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"
import { SnapshotCapture } from "./snapshot-capture"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotLease } from "./snapshot-lease"
import type { SnapshotSchema } from "./snapshot-schema"

export namespace SnapshotLive {
  export const Unavailable = NamedError.create("LiveComparisonUnavailable", z.object({ message: z.string() }))
  type Revision = {
    owner: Owner
    from: string
    to: string
    omissions: SnapshotSchema.Omission[]
    objects: Set<string>
    readers: number
  }
  type Owner = {
    operation: SnapshotStore.Operation
    from: string
    latest?: string
    closed: boolean
    references: Map<string, number>
    serial: Promise<unknown>
    release(): Promise<void>
  }
  const state = RuntimeContext.state(() => ({ revisions: new Map<string, Revision>(), owners: new Set<Owner>() }))

  function serial<T>(owner: Owner, action: () => Promise<T>) {
    const result = owner.serial.catch(() => {}).then(action)
    owner.serial = result
    return result
  }

  function resolve(sessionID: string, revision: string) {
    const value = state().revisions.get(revision)
    if (
      !value ||
      value.owner.operation.sessionID !== sessionID ||
      value.owner.operation.scopeID !== ScopeContext.current.scope.id
    )
      throw new Unavailable({ message: "This live comparison expired; refresh to read the latest recorded changes" })
    return value
  }

  async function discard(revision: string) {
    const value = state().revisions.get(revision)
    if (!value || value.readers || value.owner.latest === revision) return
    state().revisions.delete(revision)
    const owner = value.owner
    for (const object of value.objects) {
      const count = (owner.references.get(object) ?? 1) - 1
      if (count) owner.references.set(object, count)
      else {
        owner.references.delete(object)
        await fs.rm(path.join(owner.operation.repository, "objects", object.slice(0, 2), object.slice(2)), {
          force: true,
        })
      }
    }
    await cleanup(owner)
  }

  async function cleanup(owner: Owner) {
    if (!state().owners.has(owner)) return
    if (!owner.closed || [...state().revisions.values()].some((value) => value.owner === owner)) return
    state().owners.delete(owner)
    await fs.rm(owner.operation.temporary, { recursive: true, force: true })
    await owner.release()
  }

  export function retain(sessionID: string, revision: string) {
    const value = resolve(sessionID, revision)
    value.readers++
    let released = false
    return async () => {
      if (released) return
      released = true
      value.readers--
      await serial(value.owner, () => discard(revision))
    }
  }

  export async function read<T>(
    sessionID: string,
    revision: string,
    action: (value: Readonly<Revision>) => Promise<T>,
  ) {
    const value = resolve(sessionID, revision)
    const release = retain(sessionID, revision)
    try {
      return await SnapshotStore.withOperation(value.owner.operation, () => action(value))
    } finally {
      await release()
    }
  }

  export async function create(sessionID: string, from: string) {
    return SnapshotStore.withSession(sessionID, async () => {
      if (!(await SnapshotStore.ownsCurrent(from)))
        throw new Unavailable({ message: "The original baseline is unavailable" })
      const source = SnapshotStore.current()
      const lease = await SnapshotLease.acquire(source.scopeID, false)
      const temporary = path.join(source.temporary, `live-${RuntimeContext.current().id}-${crypto.randomUUID()}`)
      const operation: SnapshotStore.Operation = {
        ...source,
        temporary,
        repository: path.join(temporary, "store.git"),
        index: path.join(temporary, "index"),
        transient: true,
      }
      const run = async (args: string[], input?: string) => {
        const result = await SnapshotGit.run(
          ["git", "--git-dir", operation.repository, ...args],
          temporary,
          { GIT_INDEX_FILE: operation.index, GIT_LITERAL_PATHSPECS: "1" },
          AbortSignal.timeout(30000),
          input,
        )
        if (result.exitCode !== 0)
          throw new SnapshotStore.StorageError(`Live snapshot ${args[0]} failed: ${result.stderr}`)
        return result.text.trim()
      }
      try {
        await SnapshotStore.initializeBareRepository(operation.repository)
        await fs.writeFile(
          path.join(operation.repository, "objects/info/alternates"),
          path.join(source.repository, "objects") + "\n",
          { mode: 0o600 },
        )
        await run(["read-tree", from])
      } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true })
        await lease[Symbol.asyncDispose]()
        throw error
      }
      const owner: Owner = {
        operation,
        from,
        closed: false,
        references: new Map(),
        serial: Promise.resolve(),
        release: () => lease[Symbol.asyncDispose](),
      }
      state().owners.add(owner)
      return {
        refresh(paths: readonly string[], initialOmissions: SnapshotSchema.Omission[] = []) {
          return serial(owner, async () => {
            if (owner.closed) throw new Unavailable({ message: "Live observation has closed" })
            const previous = owner.latest ? state().revisions.get(owner.latest) : undefined
            let omissions = previous?.omissions ?? initialOmissions
            await SnapshotCapture.refresh(
              operation,
              undefined,
              undefined,
              (value) => {
                omissions = value
              },
              { paths, omissions },
            )
            const to = await run(["write-tree"])
            if (previous?.to === to && JSON.stringify(previous.omissions) === JSON.stringify(omissions))
              return owner.latest!
            // Git's reachability walk excludes durable baseline objects; only live loose objects need reference counts.
            const objects = new Set(
              (await run(["rev-list", "--objects", "--no-object-names", to, "--not", from]))
                .split("\n")
                .filter(Boolean),
            )
            for (const object of objects) owner.references.set(object, (owner.references.get(object) ?? 0) + 1)
            const revision = crypto.randomUUID()
            state().revisions.set(revision, { owner, from, to, omissions, objects, readers: 0 })
            const old = owner.latest
            owner.latest = revision
            if (old) await discard(old)
            return revision
          })
        },
        retainedObjects: async () => {
          await owner.serial
          return owner.references.size
        },
        close() {
          return serial(owner, async () => {
            owner.closed = true
            const old = owner.latest
            owner.latest = undefined
            if (old) await discard(old)
            await cleanup(owner)
          })
        },
      }
    })
  }

  export async function dispose() {
    for (const owner of state().owners) {
      await owner.serial.catch(() => {})
      owner.closed = true
      owner.latest = undefined
      for (const [id, value] of state().revisions) if (value.owner === owner) state().revisions.delete(id)
      await cleanup(owner)
    }
  }
}

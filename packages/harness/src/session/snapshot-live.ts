import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { processStartIdentity } from "@ericsanchezok/synergy-util/process-identity"
import { Global } from "../global"
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
    statistics?: Promise<SnapshotSchema.FileDiff[]>
    inherited?: { statistics: Promise<SnapshotSchema.FileDiff[]>; paths: readonly string[] }
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
  const ProcessOwner = z.object({ pid: z.number().int().positive(), identity: z.string().optional() })
  const recovered = RuntimeContext.state(() => reclaim())

  async function reclaim() {
    const root = path.join(Global.Path.cache, "snapshot-live")
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("live-")) continue
      const directory = path.join(root, entry.name)
      const result = ProcessOwner.safeParse(
        await Bun.file(path.join(directory, "owner.json"))
          .json()
          .catch(() => undefined),
      )
      if (!result.success) continue
      const owner = result.data
      let dead = false
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH"
      }
      if (!dead && owner.identity) {
        const identity = await processStartIdentity(owner.pid)
        dead = identity !== undefined && identity !== owner.identity
      }
      if (dead) await fs.rm(directory, { recursive: true, force: true })
    }
    return root
  }

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

  export function statistics(
    sessionID: string,
    revision: string,
    compare: (from: string, to: string, paths?: readonly string[]) => Promise<SnapshotSchema.FileDiff[]>,
  ) {
    return read(sessionID, revision, async () => {
      const value = resolve(sessionID, revision)
      value.statistics ??= (async () => {
        const inherited = value.inherited
        const previous = await inherited?.statistics
        const updated = await compare(value.from, value.to, inherited?.paths)
        const selection = SnapshotCapture.selection(inherited?.paths)
        const omitted = new Set(value.omissions.map((item) => item.file))
        const rows = [...(previous?.filter((row) => !selection.affected(row.file)) ?? []), ...updated]
          .filter((row) => !omitted.has(row.file))
          .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
        value.inherited = undefined
        return rows
      })().catch((error) => {
        value.statistics = undefined
        value.inherited = undefined
        throw error
      })
      return value.statistics
    })
  }

  export async function create(sessionID: string, from: string, endpoint = from) {
    return SnapshotStore.withSession(sessionID, async () => {
      if (!(await SnapshotStore.ownsCurrentRoots([from, endpoint])))
        throw new Unavailable({ message: "The original baseline is unavailable" })
      const source = SnapshotStore.current()
      const temporary = path.join(await recovered(), `live-${RuntimeContext.current().id}-${crypto.randomUUID()}`)
      const lease = await SnapshotLease.acquire(source.scopeID, false)
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
        await fs.mkdir(temporary, { mode: 0o700 })
        await Bun.write(
          path.join(temporary, "owner.json"),
          JSON.stringify({ pid: process.pid, identity: await processStartIdentity(process.pid) }),
          { mode: 0o600 },
        )
        // Provenance: https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsync
        // Runtime-only objects expire after restart; durable checkpoints retain the store's fsync policy.
        await SnapshotStore.initializeBareRepository(operation.repository, "transient")
        await fs.writeFile(
          path.join(operation.repository, "objects/info/alternates"),
          path.join(source.repository, "objects") + "\n",
          { mode: 0o600 },
        )
        await run(["read-tree", endpoint])
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
        withBaselineLease: lease.run,
        refresh(paths: readonly string[], initialOmissions: SnapshotSchema.Omission[] = []) {
          return serial(owner, async () => {
            if (owner.closed) throw new Unavailable({ message: "Live observation has closed" })
            const previous = owner.latest ? state().revisions.get(owner.latest) : undefined
            let omissions = previous?.omissions ?? initialOmissions
            try {
              const { paths: selected } = await SnapshotCapture.refresh(
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
              const incremental =
                selected && selected.reduce((bytes, file) => bytes + Buffer.byteLength(file) + 1, 0) <= 64 * 1024
              state().revisions.set(revision, {
                owner,
                from,
                to,
                omissions,
                objects,
                readers: 0,
                inherited:
                  previous?.statistics && incremental
                    ? { statistics: previous.statistics, paths: selected }
                    : undefined,
              })
              const old = owner.latest
              owner.latest = revision
              if (old) await discard(old)
              return revision
            } catch (error) {
              await run(["read-tree", previous?.to ?? endpoint])
              const objects = path.join(operation.repository, "objects")
              for (const prefix of await fs.readdir(objects)) {
                if (!/^[0-9a-f]{2}$/.test(prefix)) continue
                for (const suffix of await fs.readdir(path.join(objects, prefix)))
                  if (!owner.references.has(prefix + suffix))
                    await fs.rm(path.join(objects, prefix, suffix), { force: true })
              }
              throw error
            }
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

import { RuntimeContext } from "../lifecycle/context"
import path from "node:path"
import { createHash } from "node:crypto"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { StorageQueue } from "./queue"
import { AsyncLocalStorage } from "node:async_hooks"
import { ArtifactPack } from "./artifact-pack"
import { ObjectArtifacts, type ObjectArtifactOptions } from "./object-artifacts"
import type { ArtifactLocation } from "./artifact-location"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import {
  NotFoundError as MissingRecord,
  StorageBusyError as BusyStorage,
  StorageClosedError,
  StorageCommitUnknownError,
  StorageConflictError,
  StorageUnavailableError as UnavailableStorage,
} from "./errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
  type RecordQuery,
  type StoredEvent,
} from "./transactional-store"
import { measureStorageOperation } from "./measure"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityResources } from "../observability/resources"
import { StorageEventSinks } from "./event-sinks"
import { observeStorageProgress } from "./progress"

export namespace Storage {
  export const NotFoundError = MissingRecord
  export const BusyError = BusyStorage
  export const UnavailableError = UnavailableStorage
  export const writeJsonAtomic = AtomicFile.writeJsonAtomic
  export interface Handle {
    store: TransactionalStore
    artifactDirectory: string
    artifactObjects?: ObjectArtifactOptions
  }
  interface Context extends Handle {
    owner?: RuntimeContext.Instance
    migrationAccess?: boolean
    transaction?: StoreTransaction
    effects?: Array<() => Promise<unknown> | void>
    settled?: Array<(outcome: "committed" | "aborted" | "unknown") => void>
    pending?: Promise<unknown>[]
    eventCapture?: Promise<void>
  }
  const context = new AsyncLocalStorage<Context>()

  export function state<T>(create: () => T): () => T {
    const runtimeValues = RuntimeContext.state(() => new WeakMap<TransactionalStore, T>())
    return () => {
      const store = current().store
      const values = runtimeValues()
      let value = values.get(store)
      if (value === undefined) {
        value = create()
        values.set(store, value)
      }
      return value
    }
  }

  export function current(): Context {
    const owner = RuntimeContext.tryCurrent()
    const active = context.getStore()
    const value = active?.owner === owner ? (active ?? owner?.storage) : owner?.storage
    if (!value) throw new StorageClosedError()
    return value
  }

  export function available() {
    const owner = RuntimeContext.tryCurrent()
    return Boolean((context.getStore()?.owner === owner && context.getStore()) || owner?.storage)
  }

  /** Reports a terminally failed store; the host must restart the Runtime
   *  because the installed Handle cannot serve further work. Safe to call
   *  before any Handle is installed. */
  export function onUnavailable(listener: (error: Error) => void): () => void {
    const handle = available() ? current() : undefined
    if (!handle) return () => {}
    return handle.store.onUnavailable(listener)
  }

  export function provide<T>(handle: Handle, body: () => T): T {
    if (inTransaction() && current().store !== handle.store)
      throw new StorageConflictError("Cannot replace storage inside a transaction")
    return context.run({ ...handle, owner: RuntimeContext.current() }, body)
  }

  export function withMigrationRecords<T>(body: () => T): T {
    const parent = current()
    if (parent.transaction && !parent.migrationAccess)
      throw new StorageConflictError("Migration access must precede a business transaction")
    return context.run({ ...parent, owner: RuntimeContext.current(), migrationAccess: true }, body)
  }

  export async function transaction<T>(
    body: (tx: StoreTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const parent = current()
    if (parent.transaction) {
      if (options?.operationID) throw new StorageConflictError("Idempotency belongs to the outer business transaction")
      return body(parent.transaction)
    }
    let effects: Array<() => Promise<unknown> | void> = []
    const settled: NonNullable<Context["settled"]> = []
    let outcome: "committed" | "aborted" | "unknown" = "aborted"
    try {
      const result = await parent.store.transaction(async (tx) => {
        if (!parent.migrationAccess) tx.restrictToPublishedOwners()
        effects = []
        const pending: Promise<unknown>[] = []
        return RuntimeContext.transaction(() =>
          context.run(
            { ...parent, owner: RuntimeContext.current(), transaction: tx, effects, pending, settled },
            async () => {
              const result = await body(tx)
              for (let offset = 0; offset < pending.length; ) {
                const batch = pending.slice(offset)
                offset += batch.length
                await Promise.all(batch)
              }
              return result
            },
          ),
        )
      }, options)
      outcome = "committed"
      for (const effect of effects) {
        try {
          await effect()
        } catch (error) {
          ObservabilityIssues.raise({
            code: "STORAGE_POST_COMMIT_FAILED",
            severity: "error",
            module: "storage",
            title: "A committed change could not publish its notification",
            message: "The database commit succeeded. Pending events remain available for reconciliation.",
            evidence: { errorName: error instanceof Error ? error.name : "unknown" },
          })
        }
      }
      return result
    } catch (error) {
      if (error instanceof StorageCommitUnknownError) outcome = "unknown"
      throw error
    } finally {
      for (const release of settled) release(outcome)
    }
  }

  export function snapshot<T>(
    body: (tx: StoreTransaction) => Promise<T>,
    options: { singleStatement?: boolean } = {},
  ): Promise<T> {
    const parent = current()
    if (parent.transaction) return body(parent.transaction)
    return parent.store.snapshot(
      (tx) => {
        if (!parent.migrationAccess) tx.restrictToPublishedOwners()
        return RuntimeContext.transaction(() =>
          context.run({ ...parent, owner: RuntimeContext.current(), transaction: tx }, () => body(tx)),
        )
      },
      {
        ...options,
        singleStatement: options.singleStatement && (parent.migrationAccess || !parent.store.hasUnpublishedOwners()),
      },
    )
  }

  export function inTransaction() {
    const active = context.getStore()
    return active?.owner === RuntimeContext.tryCurrent() && Boolean(active?.transaction)
  }

  export function inWriteTransaction() {
    const active = context.getStore()
    return active?.owner === RuntimeContext.tryCurrent() && Boolean(active?.transaction && active.effects)
  }

  export function afterCommit(effect: () => Promise<unknown> | void): void {
    const active = context.getStore()
    if (!active?.effects) throw new StorageConflictError("Post-commit effects require a write transaction")
    active.effects.push(effect)
  }

  export function enqueue(event: StoredEvent, effect: () => Promise<void>): Promise<void> {
    const active = context.getStore()
    if (!active?.transaction || !active.effects || !active.pending)
      throw new StorageConflictError("An event requires a write transaction")
    const tx = active.transaction
    const pending = (active.eventCapture ?? Promise.resolve()).then(async () => {
      await StorageEventSinks.capture(tx, event)
      await tx.enqueue(event)
    })
    active.eventCapture = pending
    active.pending.push(pending)
    void pending.catch(() => {})
    active.effects.push(async () => {
      await effect()
      await active.store.acknowledgeEvents([event.id])
    })
    return pending
  }

  export function read<T>(key: string[], options: { silentNotFound?: boolean } = {}): Promise<T> {
    return measureStorage("read", key, () => snapshot((tx) => tx.read<T>(key), { singleStatement: true }), options)
  }

  export function readMany<T>(keys: string[][]): Promise<(T | undefined)[]> {
    return measureStorage("readMany", [keys[0]?.[0] ?? "root"], () =>
      snapshot((tx) => tx.readMany<T>(keys), { singleStatement: keys.length <= 128 }),
    )
  }

  export function versioned<T>(key: string[]) {
    return snapshot((tx) => tx.versioned<T>(key), { singleStatement: true })
  }

  export function write<T>(key: string[], value: T) {
    return measureStorage("write", key, () => transaction((tx) => tx.write(key, value)))
  }

  export function update<T>(key: string[], change: (value: T) => void): Promise<T> {
    return measureStorage("update", key, () => transaction((tx) => tx.update(key, change)))
  }

  export function remove(key: string[]) {
    return measureStorage("remove", key, () => transaction((tx) => tx.remove(key)))
  }

  export function removeTree(prefix: string[]) {
    return measureStorage("removeTree", prefix, () => transaction((tx) => tx.removeTree(prefix)))
  }

  export function scan(prefix: string[]) {
    return measureStorage("scan", prefix, () => snapshot((tx) => tx.scan(prefix), { singleStatement: true }))
  }

  export function list(prefix: string[]) {
    return measureStorage("list", prefix, () => snapshot((tx) => tx.list(prefix), { singleStatement: true }))
  }

  export function query<T>(input: RecordQuery) {
    return snapshot((tx) => tx.query<T>(input), { singleStatement: true })
  }

  export function queryKeys(input: RecordQuery) {
    return snapshot((tx) => tx.queryKeys(input), { singleStatement: true })
  }

  export function count(input: Omit<RecordQuery, "limit" | "after" | "descending">) {
    return snapshot((tx) => tx.count(input), { singleStatement: true })
  }

  export async function* records<T>(input: Omit<RecordQuery, "after"> = {}) {
    let after: string[] | undefined
    for (;;) {
      const page = await query<T>({ ...input, after, limit: input.limit ?? 256 })
      if (!page.length) return
      yield* page
      if (page.length < (input.limit ?? 256)) return
      after = page.at(-1)!.key
    }
  }

  const runtimePacks = RuntimeContext.state(
    () =>
      new WeakMap<
        TransactionalStore,
        { pack: ArtifactPack; objects?: ObjectArtifacts; gate: StorageQueue; prepared: Map<string, number> }
      >(),
  )
  function artifactPack(key: string[]) {
    if (!key.length || key.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
      throw new StorageConflictError("Invalid artifact key")
    const handle = current()
    const artifactPacks = runtimePacks()
    let pack = artifactPacks.get(handle.store)
    if (!pack) {
      pack = {
        pack: new ArtifactPack(path.join(handle.artifactDirectory, "agent-artifacts")),
        objects: handle.artifactObjects ? new ObjectArtifacts(handle.store, handle.artifactObjects) : undefined,
        gate: new StorageQueue("artifact.gate"),
        prepared: new Map(),
      }
      artifactPacks.set(handle.store, pack)
    }
    return pack
  }

  const preparedBinaryBrand = Symbol("prepared-binary")
  export type PreparedBinary = Disposable & { readonly [preparedBinaryBrand]: true }
  const preparedBinaries = new WeakMap<
    PreparedBinary,
    {
      store: TransactionalStore
      runtime: RuntimeContext.Instance
      key: string[]
      location: ArtifactLocation
      released: boolean
      publishing: boolean
      outcome: "committed" | "aborted" | "unknown"
    }
  >()

  export async function prepareBinary(key: string[], content: Uint8Array): Promise<PreparedBinary> {
    if (current().transaction)
      throw new StorageConflictError("Artifact bytes must be flushed before the business transaction")
    const state = artifactPack(key)
    const bytes = new Uint8Array(content)
    return state.gate.run(async () => {
      const hash = createHash("sha256").update(bytes).digest("hex")
      const previous = await snapshot((tx) => tx.artifact(key)).catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined
        throw error
      })
      const existing = previous?.sha256 === hash && previous.size === bytes.byteLength
      if (existing && !state.objects) await state.pack.verify(previous)
      const owner = JSON.stringify(key.slice(0, ["sessions", "operations"].includes(key[0]) ? 3 : 1))
      const object = await state.objects?.prepare(bytes)
      const location = object?.location ?? (existing ? previous : await state.pack.append(bytes, owner))
      const held = {
        store: current().store,
        runtime: RuntimeContext.current(),
        key: [...key],
        location,
        released: false,
        publishing: false,
        outcome: "aborted" as "committed" | "aborted" | "unknown",
      }
      state.prepared.set(location.pack, (state.prepared.get(location.pack) ?? 0) + 1)
      const token: PreparedBinary = {
        [preparedBinaryBrand]: true,
        [Symbol.dispose]() {
          if (held.released || held.publishing) return
          held.released = true
          if (object) state.objects!.release(object, held.outcome)
          const count = (state.prepared.get(location.pack) ?? 1) - 1
          if (count) state.prepared.set(location.pack, count)
          else state.prepared.delete(location.pack)
        },
      }
      preparedBinaries.set(token, held)
      if (object) preparedObjects.set(token, { backend: state.objects!, object })
      ObservabilityResources.addWrite(content.byteLength)
      return token
    })
  }

  const preparedObjects = new WeakMap<
    PreparedBinary,
    { backend: ObjectArtifacts; object: Awaited<ReturnType<ObjectArtifacts["prepare"]>> }
  >()

  export async function publishPreparedBinary(token: PreparedBinary) {
    const prepared = preparedBinaries.get(token)
    const handle = current()
    if (!handle.transaction)
      throw new StorageConflictError("Prepared artifact publication requires a write transaction")
    if (
      !prepared ||
      prepared.released ||
      prepared.store !== handle.store ||
      prepared.runtime !== RuntimeContext.current()
    )
      throw new StorageConflictError("Prepared artifact belongs to a different or released storage owner")
    if (!handle.settled) throw new StorageConflictError("Prepared artifacts require an owned write transaction")
    prepared.publishing = true
    handle.settled.push((outcome) => {
      prepared.publishing = false
      prepared.outcome = outcome
      token[Symbol.dispose]()
    })
    await handle.transaction.writeArtifacts([{ key: prepared.key, location: prepared.location }])
    const object = preparedObjects.get(token)
    if (object) await object.backend.publish(handle.transaction, object.object)
  }

  export async function writeBinary(key: string[], content: Uint8Array) {
    using prepared = await prepareBinary(key, content)
    await transaction(() => publishPreparedBinary(prepared))
  }

  export async function readBinary(key: string[], options?: { maxBytes?: number }): Promise<Uint8Array> {
    const state = artifactPack(key)
    const handle = current()
    const read = async () => {
      const location = handle.transaction
        ? await handle.transaction.artifact(key)
        : await snapshot((tx) => tx.artifact(key))
      const content = await (state.objects ?? state.pack).read(location, options?.maxBytes)
      ObservabilityResources.addRead(content.byteLength)
      return content
    }
    return handle.transaction ? read() : state.gate.run(read)
  }

  export async function validateArtifacts(
    handle: Handle,
    options: { accept?: (key: string[]) => boolean; progress?: (count: number) => void } = {},
  ) {
    if (handle.artifactObjects) {
      const objects = new ObjectArtifacts(handle.store, handle.artifactObjects)
      return objects.validate(options)
    }
    const pack = new ArtifactPack(path.join(handle.artifactDirectory, "agent-artifacts"))
    let count = 0
    await withFileLock(
      { directory: path.join(handle.artifactDirectory, "storage", ".locks"), key: "artifact-packs" },
      () =>
        handle.store.snapshot(async (tx) => {
          for await (const entry of tx.artifacts()) {
            if (options.accept && !options.accept(entry.key)) continue
            await pack.verify(entry.location)
            if (++count % 256 === 0) options.progress?.(count)
          }
        }),
    )
    options.progress?.(count)
    return count
  }

  export async function collectArtifactGarbage(
    options: { scanOrphans?: boolean; progress?: (current: number) => void } = {},
  ) {
    if (current().transaction) throw new StorageConflictError("Artifact collection requires a committed transaction")
    const state = artifactPack(["storage"])
    if (state.objects) return state.gate.run(() => state.objects!.collect(state.prepared.keys(), options.progress))
    const store = current().store
    const busy = "Artifact files are pinned by another maintenance operation"
    try {
      return await withFileLock(
        {
          directory: path.join(current().artifactDirectory, "storage", ".locks"),
          key: "artifact-packs",
          timeoutMs: 100,
          timeoutMessage: busy,
        },
        () =>
          state.gate.run(() =>
            observeStorageProgress(async (report) => {
              let current = 0
              const advance = () => report(++current)
              let removed = 0
              const reclaimed = new Set<string>()
              if (options.scanOrphans) {
                const referenced = await store.snapshot(async (tx) => {
                  const result = new Set<string>()
                  for await (const pack of tx.artifactPacks()) {
                    result.add(pack)
                    advance()
                  }
                  return result
                })
                for (const key of await store.list(["storage_pack_pins"])) {
                  referenced.add(key[1])
                  advance()
                }
                for (const pack of state.prepared.keys()) referenced.add(pack)
                const orphans = await state.pack.orphaned(referenced, advance)
                await state.pack.prune(orphans, advance)
                for (const name of orphans) reclaimed.add(name)
                removed += orphans.length
              }
              for (;;) {
                const candidates = await store.snapshot((tx) => tx.artifactGarbage())
                if (!candidates.length) return removed
                const pins = new Set((await store.list(["storage_pack_pins"])).map((key) => key[1]))
                for (const pack of state.prepared.keys()) pins.add(pack)
                const unused = candidates
                  .filter((entry) => !entry.used && !pins.has(entry.pack) && !reclaimed.has(entry.pack))
                  .map((entry) => entry.pack)
                await state.pack.prune(unused, advance)
                const acknowledged = candidates.filter((entry) => !pins.has(entry.pack)).map((entry) => entry.pack)
                await store.transaction((tx) => tx.acknowledgeArtifactGarbage(acknowledged))
                current += candidates.length
                report(current)
                if (acknowledged.length < candidates.length) return removed + unused.length
                removed += unused.length
              }
            }, options.progress),
          ),
      )
    } catch (error) {
      if (error instanceof Error && error.message === busy) return 0
      throw error
    }
  }

  /** Maintenance only, after the owning Host proves this exact previous writer stopped. */
  export async function retireArtifactWriter(writerID: string) {
    if (current().transaction)
      throw new StorageConflictError("Artifact writer retirement requires a committed transaction")
    const state = artifactPack(["storage"])
    if (!state.objects) throw new StorageConflictError("This Handle does not use object artifacts")
    await state.gate.run(() => state.objects!.retireWriter(writerID))
  }

  // One measurement source for the whole store: this surface and the store
  // primitives that query the driver directly share `measureStorageOperation`,
  // so latency, volume and errors agree and no operation is invisible.
  function measureStorage<T>(
    operation: string,
    key: string[],
    body: () => Promise<T>,
    options: { silentNotFound?: boolean } = {},
  ) {
    return measureStorageOperation(operation, key[0] ?? "root", body, options)
  }
}

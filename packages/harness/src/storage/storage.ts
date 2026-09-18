import path from "node:path"
import { createHash } from "node:crypto"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { StorageQueue } from "./queue"
import { AsyncLocalStorage } from "node:async_hooks"
import { ArtifactPack } from "./artifact-pack"
import { AtomicFile } from "./atomic-file"
import { NotFoundError as MissingRecord, StorageClosedError, StorageConflictError } from "./errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
  type RecordQuery,
  type StoredEvent,
} from "./transactional-store"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"
import { ObservabilityResources } from "../observability/resources"

export namespace Storage {
  const STORAGE_DURATION_SAMPLE_RATE = 0.02
  export const NotFoundError = MissingRecord
  export const writeJsonAtomic = AtomicFile.writeJsonAtomic
  export interface Handle {
    store: TransactionalStore
    artifactDirectory: string
  }
  interface Context extends Handle {
    transaction?: StoreTransaction
    effects?: Array<() => Promise<unknown> | void>
    pending?: Promise<unknown>[]
  }
  const context = new AsyncLocalStorage<Context>()
  let installed: Handle | undefined

  export function state<T>(create: () => T): () => T {
    const values = new WeakMap<TransactionalStore, T>()
    return () => {
      const store = current().store
      let value = values.get(store)
      if (value === undefined) {
        value = create()
        values.set(store, value)
      }
      return value
    }
  }

  export function install(handle: Handle) {
    if (installed === handle) return () => {}
    if (installed && installed !== handle) throw new StorageConflictError("A storage Handle is already installed")
    installed = handle
    return () => {
      if (installed === handle) installed = undefined
    }
  }

  export function current(): Context {
    const value = context.getStore() ?? installed
    if (!value) throw new StorageClosedError()
    return value
  }

  export function available() {
    return Boolean(context.getStore() ?? installed)
  }

  export function provide<T>(handle: Handle, body: () => T): T {
    return context.run(handle, body)
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
    const result = await parent.store.transaction(async (tx) => {
      effects = []
      const pending: Promise<unknown>[] = []
      return context.run({ ...parent, transaction: tx, effects, pending }, async () => {
        const result = await body(tx)
        for (let offset = 0; offset < pending.length; ) {
          const batch = pending.slice(offset)
          offset += batch.length
          await Promise.all(batch)
        }
        return result
      })
    }, options)
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
  }

  export function snapshot<T>(body: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    const parent = current()
    if (parent.transaction) return body(parent.transaction)
    return parent.store.snapshot((tx) => context.run({ ...parent, transaction: tx }, () => body(tx)))
  }

  export function inTransaction() {
    return Boolean(context.getStore()?.transaction)
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
    const pending = active.transaction.enqueue(event)
    active.pending.push(pending)
    void pending.catch(() => {})
    active.effects.push(async () => {
      await effect()
      await active.store.acknowledgeEvents([event.id])
    })
    return pending
  }

  export function read<T>(key: string[], options: { silentNotFound?: boolean } = {}): Promise<T> {
    return measureStorage("read", key, () => snapshot((tx) => tx.read<T>(key)), options)
  }

  export function readMany<T>(keys: string[][]): Promise<(T | undefined)[]> {
    return measureStorage("readMany", [keys[0]?.[0] ?? "root"], () => snapshot((tx) => tx.readMany<T>(keys)))
  }

  export function versioned<T>(key: string[]) {
    return snapshot((tx) => tx.versioned<T>(key))
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
    return measureStorage("scan", prefix, () => snapshot((tx) => tx.scan(prefix)))
  }

  export function list(prefix: string[]) {
    return measureStorage("list", prefix, () => snapshot((tx) => tx.list(prefix)))
  }

  export function query<T>(input: RecordQuery) {
    return snapshot((tx) => tx.query<T>(input))
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

  const artifactPacks = new WeakMap<TransactionalStore, { pack: ArtifactPack; gate: StorageQueue }>()
  function artifactPack(key: string[]) {
    if (!key.length || key.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
      throw new StorageConflictError("Invalid artifact key")
    const handle = current()
    let pack = artifactPacks.get(handle.store)
    if (!pack) {
      pack = {
        pack: new ArtifactPack(path.join(handle.artifactDirectory, "agent-artifacts")),
        gate: new StorageQueue(),
      }
      artifactPacks.set(handle.store, pack)
    }
    return pack
  }

  export async function writeBinary(key: string[], content: Uint8Array) {
    if (current().transaction)
      throw new StorageConflictError("Artifact bytes must be flushed before the business transaction")
    const state = artifactPack(key)
    const bytes = new Uint8Array(content)
    await state.gate.run(async () => {
      const hash = createHash("sha256").update(bytes).digest("hex")
      const previous = await current()
        .store.snapshot((tx) => tx.artifact(key))
        .catch((error: unknown) => {
          if (error instanceof NotFoundError) return undefined
          throw error
        })
      if (previous?.sha256 === hash && previous.size === bytes.byteLength) {
        await state.pack.verify(previous)
        return
      }
      const owner = JSON.stringify(key.slice(0, ["sessions", "operations"].includes(key[0]) ? 3 : 1))
      const location = await state.pack.append(bytes, owner)
      await transaction((tx) => tx.writeArtifacts([{ key, location }]))
    })
    ObservabilityResources.addWrite(content.byteLength)
  }

  export async function readBinary(key: string[], options?: { maxBytes?: number }): Promise<Uint8Array> {
    const state = artifactPack(key)
    const handle = current()
    const read = async () => {
      const location = handle.transaction
        ? await handle.transaction.artifact(key)
        : await handle.store.snapshot((tx) => tx.artifact(key))
      const content = await state.pack.read(location, options?.maxBytes)
      ObservabilityResources.addRead(content.byteLength)
      return content
    }
    return handle.transaction ? read() : state.gate.run(read)
  }

  export async function validateArtifacts(
    handle: Handle,
    options: { accept?: (key: string[]) => boolean; progress?: (count: number) => void } = {},
  ) {
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

  export async function collectArtifactGarbage(options: { scanOrphans?: boolean } = {}) {
    if (current().transaction) throw new StorageConflictError("Artifact collection requires a committed transaction")
    const state = artifactPack(["storage"])
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
          state.gate.run(async () => {
            let removed = 0
            if (options.scanOrphans) {
              const referenced = await store.snapshot(async (tx) => {
                const result = new Set<string>()
                for await (const pack of tx.artifactPacks()) result.add(pack)
                return result
              })
              const orphans = await state.pack.orphaned(referenced)
              await state.pack.prune(orphans)
              removed += orphans.length
            }
            for (;;) {
              const candidates = await store.snapshot((tx) => tx.artifactGarbage())
              if (!candidates.length) return removed
              const unused = candidates.filter((entry) => !entry.used).map((entry) => entry.pack)
              await state.pack.prune(unused)
              await store.transaction((tx) => tx.acknowledgeArtifactGarbage(candidates.map((entry) => entry.pack)))
              removed += unused.length
            }
          }),
      )
    } catch (error) {
      if (error instanceof Error && error.message === busy) return 0
      throw error
    }
  }

  async function measureStorage<T>(
    operation: string,
    key: string[],
    body: () => Promise<T>,
    options: { silentNotFound?: boolean } = {},
  ) {
    const start = performance.now()
    let status = "ok"
    try {
      return await body()
    } catch (error) {
      status = "error"
      // Expected "file does not exist" paths (note scope probing, index
      // rebuilds) used try/catch as control flow; every miss raised a
      // PERF_STORAGE_OPERATION_ERROR issue and amplified telemetry writes.
      // Keep the error metric (observability still counts it) but skip the
      // issue when the caller declared the miss expected.
      const isNotFound = error instanceof NotFoundError
      if (!(options.silentNotFound && isNotFound)) {
        ObservabilityIssues.raise({
          code: "PERF_STORAGE_OPERATION_ERROR",
          severity: "warning",
          module: "storage",
          title: "Storage operation failed",
          message: `${operation} failed for ${key[0] ?? "root"}`,
          evidence: {
            operation,
            keyPrefix: key[0] ?? "root",
            errorName: error instanceof Error ? error.name : "unknown",
          },
        })
      }
      throw error
    } finally {
      const durationMs = performance.now() - start
      ObservabilityMetrics.record({
        name: "storage.operation.duration",
        value: durationMs,
        unit: "ms",
        module: "storage",
        labels: { operation, keyPrefix: key[0] ?? "root", status },
        sampleRate: status === "error" ? 1 : STORAGE_DURATION_SAMPLE_RATE,
      })
      ObservabilityMetrics.record({
        name: "storage.operation.count",
        value: 1,
        unit: "count",
        module: "storage",
        labels: { operation, status },
      })
      if (status === "error") {
        ObservabilityMetrics.record({
          name: "storage.operation.error",
          value: 1,
          unit: "count",
          module: "storage",
          labels: { operation },
        })
      }
    }
  }
}

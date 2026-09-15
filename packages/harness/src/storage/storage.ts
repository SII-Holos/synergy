import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
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
      after = page.at(-1)!.key
    }
  }

  function binaryPath(key: string[]) {
    if (!key.length || key.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
      throw new StorageConflictError("Invalid artifact key")
    return path.join(current().artifactDirectory, ...key) + ".bin"
  }

  export async function writeBinary(key: string[], content: Uint8Array) {
    await AtomicFile.writeFileAtomic(binaryPath(key), content, { private: true, durable: true })
    ObservabilityResources.addWrite(content.byteLength)
  }

  export async function readBinary(key: string[], options?: { maxBytes?: number }): Promise<Uint8Array> {
    const file = Bun.file(binaryPath(key))
    if (options?.maxBytes !== undefined && file.size > options.maxBytes)
      throw new StorageConflictError("Binary record exceeds its byte limit")
    try {
      const content = await file.bytes()
      ObservabilityResources.addRead(content.byteLength)
      return content
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        throw new NotFoundError({ message: "Artifact does not exist" })
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

import { createHash } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "./storage"
import { StorageIntegrityError } from "./errors"
import { bootstrapPhysicalRecordRoots } from "./bootstrap-layout"
import type { StorageEntry } from "./portable"
import type { StoreTransaction, TransactionalStore } from "./transactional-store"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (value: readonly string[]) => JSON.stringify(value)

export namespace StorageBootstrapBase {
  export interface Evidence {
    readonly kind: "storage-bootstrap-restoration-base"
  }
  const evidence = new WeakMap<Evidence, { assert(): void; records: ReadonlyMap<string, string> }>()
  function fail(): never {
    throw new StorageIntegrityError("Checkpoint restoration requires its actual unchanged preinitialized target base")
  }
  export interface Source {
    readonly kind: "storage-bootstrap-original-base"
  }
  type Captured = { assert(): void; records: ReadonlyMap<string, string>; store: TransactionalStore }
  const sources = new WeakMap<Source, Captured>()
  export async function capture(
    store: TransactionalStore,
    expected: ReadonlyMap<string, unknown>,
  ): Promise<Source | undefined> {
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const configuration = hash(store.options)
    const artifacts = handle.artifactDirectory
    if (runtime.storage !== handle || handle.store !== store || handle.artifactObjects) fail()
    const assert = () => {
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== handle ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== artifacts ||
        Storage.current().artifactObjects !== undefined ||
        handle.store !== store ||
        hash(store.options) !== configuration ||
        handle.artifactDirectory !== artifacts ||
        handle.artifactObjects ||
        !store.readiness.readerReady
      )
        fail()
    }
    assert()
    if (store.hasUnpublishedOwners()) return
    const records = new Map<string, string>()
    const empty = await store.snapshot(async (tx) => {
      const remaining = new Set(expected.keys())
      for await (const entry of tx.exportEntries()) {
        assert()
        if (entry.type !== "record") return false
        const selected = key(entry.key)
        if (!expected.has(selected) || hash(entry.value) !== hash(expected.get(selected))) return false
        remaining.delete(selected)
        records.set(selected, hash(entry))
      }
      return remaining.size === 0
    })
    assert()
    if (!empty) return
    const source: Source = Object.freeze({ kind: "storage-bootstrap-original-base" })
    sources.set(source, { assert, records, store })
    return source
  }
  export async function withBase<T>(source: Source, body: (base: Evidence) => Promise<T>) {
    const captured = sources.get(source)
    if (!captured) fail()
    captured.assert()
    let open = true
    const assert = () => {
      if (!open) fail()
      captured.assert()
    }
    const proof: Evidence = Object.freeze({ kind: "storage-bootstrap-restoration-base" })
    evidence.set(proof, { assert, records: captured.records })
    await captured.store.snapshot(async (tx) => {
      const remaining = new Set(captured.records.keys())
      for await (const entry of tx.exportEntries()) {
        if (!accepts(proof, entry)) fail()
        if (entry.type === "record") remaining.delete(key(entry.key))
      }
      if (remaining.size) fail()
    })
    try {
      const result = await body(proof)
      assert()
      return result
    } finally {
      open = false
    }
  }
  function original(base: Evidence) {
    const selected = evidence.get(base)
    if (!selected) fail()
    selected.assert()
    return selected
  }
  export function assert(base: Evidence) {
    original(base)
  }
  export function contains(base: Evidence, value: readonly string[]) {
    return original(base).records.has(key(value))
  }
  export function accepts(base: Evidence, entry: StorageEntry) {
    return entry.type === "record" && original(base).records.get(key(entry.key)) === hash(entry)
  }
  export async function protect(base: Evidence, tx: StoreTransaction) {
    const selected = original(base)
    Storage.current().store.assertWriteTransaction(tx)
    const remaining = new Set(selected.records.keys())
    for await (const entry of tx.exportEntries()) {
      if (entry.type !== "record" || !selected.records.has(key(entry.key))) continue
      if (!accepts(base, entry)) fail()
      remaining.delete(key(entry.key))
    }
    if (remaining.size) fail()
    let valid = true
    tx.addMutationGuard(async (keys, tree) => {
      original(base)
      if (keys.some((key) => bootstrapPhysicalRecordRoots.has(key[0]!) || (tree && key.length === 0))) {
        valid = false
        fail()
      }
    })
    return () => {
      original(base)
      if (!valid) fail()
    }
  }
}

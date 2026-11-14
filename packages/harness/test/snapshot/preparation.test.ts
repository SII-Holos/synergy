import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { storageTestRuntime } from "../support/storage-runtime"
import { Storage } from "../../src/storage/storage"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { StoredSnapshotContent as Content } from "../../src/session/stored-snapshot-content"
import { StoredSnapshotMaintenance as Maintenance } from "../../src/session/stored-snapshot-maintenance"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "snapshot-preparation-"))
  const runtime = await storageTestRuntime()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory, "authority.sqlite"),
    namespace: "snapshots",
  })
  return {
    directory,
    store,
    run: <T>(body: () => Promise<T>) =>
      runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(directory, "content") }, body)),
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("an actual committed stored Snapshot with a lost acknowledgement retains its paged content and reconciles the same root", async () => {
  await using f = await fixture()
  await f.run(async () => {
    SnapshotStore.registerStorage(storedSnapshots())
    const operation = await SnapshotStore.resolveRepository("scope", "retention")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Retained after unknown commit",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tfile.txt\n`,
    )
    const key = [...Content.key("scope", "retention", root), "manifest"]
    const transaction = f.store.transaction.bind(f.store)
    let lost = false
    const fault = spyOn(f.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        let publishing = false
        const result = await transaction(async (tx) => {
          const [before] = await tx.readMany([key])
          const value = await body(tx)
          const [after] = await tx.readMany([key])
          publishing = before === undefined && after !== undefined
          return value
        }, options)
        if (publishing && !lost) {
          lost = true
          throw new StorageCommitUnknownError(
            "stored-snapshot-fixture",
            new Error("Fixture SQL commit acknowledgement lost"),
          )
        }
        return result
      },
    )
    try {
      await expect(SnapshotStore.retainMany("scope", "retention", [root])).rejects.toBeInstanceOf(
        StorageCommitUnknownError,
      )
    } finally {
      fault.mockRestore()
    }
    const header = Content.Header.parse(await Content.read("scope", "retention", root))
    await SnapshotStore.retainMany("scope", "retention", [root])
    expect(await Content.read("scope", "retention", root)).toEqual(header)
    expect(await Maintenance.collect("scope", "retention")).toEqual({ removed: 0 })
    await fs.rm(operation.repository, { recursive: true, force: true })
    expect(await SnapshotStore.owns("scope", "retention", root)).toBeTrue()
    expect(await SnapshotStore.command(operation.repository, ["show", `${root}:file.txt`])).toBe(
      "Retained after unknown commit",
    )
  })
})

test("native preparation cleanup removes only unpublished contents and refuses unknown canonical manifests", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const root = "a".repeat(40)
    const intent = await Maintenance.begin("scope", "retention", root)
    const writer = new Content.Writer("scope", "retention", root, intent.contentID, "chunks-v2")
    const bytes = new TextEncoder().encode("unpublished private bytes")
    const header = { root, contentID: intent.contentID, layout: "chunks-v2" as const, version: 2 as const }
    const ref = { pack: 0, index: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    await Storage.writeBinary(Content.chunkKey("scope", "retention", header, ref), bytes)
    await writer.append(ref)
    await writer.seal()
    await storedSnapshots().release?.("scope", "retention")
    expect(await Storage.read(["stored_snapshot_preparation", "scope", "retention", intent.contentID])).toEqual(intent)
    expect(await SnapshotMaintenance.collectStoredPreparations("scope", "retention")).toEqual({ removed: 1 })
    expect(
      await f.store.snapshot(async (tx) => {
        let count = 0
        for await (const _ of tx.artifacts(Content.contentKey("scope", "retention", intent))) count++
        return count
      }),
    ).toBe(0)
    const retained = await Maintenance.begin("scope", "retention", root)
    await Storage.write([...Content.key("scope", "retention", root), "manifest"], {
      version: 999,
      root,
      unknown: "must survive",
    })
    await expect(Maintenance.collect("scope", "retention")).rejects.toThrow()
    expect(await Storage.read([...Content.key("scope", "retention", root), "manifest"])).toEqual({
      version: 999,
      root,
      unknown: "must survive",
    })
    expect(await Storage.read(["stored_snapshot_preparation", "scope", "retention", retained.contentID])).toEqual(
      retained,
    )
  })
})

test("cancellation while a complete Snapshot waits for the actual native writer cannot publish its root seal", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const root = "a".repeat(40)
    const intent = await Maintenance.begin("scope", "retention", root)
    const writer = new Content.Writer("scope", "retention", root, intent.contentID, "chunks-v2")
    await writer.append({ pack: 0, index: 0, bytes: 1, sha256: "b".repeat(64) })
    const header = await writer.seal()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holding = f.store.transaction(async (tx) => {
      await tx.write(["fixture", "writer"], { retained: true })
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const queued = Promise.withResolvers<void>()
    const transaction = f.store.transaction.bind(f.store)
    const observe = spyOn(f.store, "transaction").mockImplementation(
      <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        queued.resolve()
        return transaction(body, options)
      },
    )
    const controller = new AbortController()
    const reason = new Error("Stop waiting for Snapshot publication")
    const publishing = Maintenance.publish(intent, header, undefined, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await queued.promise
      controller.abort(reason)
      release.resolve()
      await holding
      expect(await publishing).toBe(reason)
      expect(await Content.read("scope", "retention", root)).toBeUndefined()
    } finally {
      observe.mockRestore()
      release.resolve()
      await holding
      await publishing
    }
    expect(await Maintenance.collect("scope", "retention")).toEqual({ removed: 1 })
  })
})

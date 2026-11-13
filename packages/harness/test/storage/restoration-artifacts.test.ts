import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { HomeRestoration } from "../../src/lifecycle/home-restoration"
import { RuntimeContext } from "../../src/lifecycle/context"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Storage } from "../../src/storage/storage"
import { StorageCommitUnknownError, StorageConflictError, StorageIntegrityError } from "../../src/storage/errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { testRuntime } from "../support/runtime"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const references = [
  ["new", "one"],
  ["new", "two"],
  ["new", "three"],
]
async function fixture() {
  const source = await testRuntime({
    register() {
      RuntimeMaintenance.configure({
        required: ["sessions", "loop-jobs", "environments", "workspace-mounts", "workspace-operations"],
      })
    },
  })
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key: material }
    },
    async resolve() {
      return material
    },
  }
  const capture = (archiveID: string) =>
    source.run(async () => {
      const requestID = crypto.randomUUID()
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID,
        actor: { kind: "system", subjectID: "operator", displayName: "Operator", clientKind: "system", requestID },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const directory = path.join(source.host.home, archiveID)
      const manifest = await RuntimeMaintenance.withFrozen(lease, () =>
        StorageCheckpoint.exportArchive({
          directory,
          archiveID,
          namespaceID: "original-source",
          buildVersion: "fixture",
          keys,
          protect: () => true,
        }),
      )
      await RuntimeMaintenance.release(lease)
      return { directory, expected: manifest }
    })
  await source.run(async () => {
    await Storage.write(["original", "sentinel"], { retained: true })
    await Storage.writeBinary(["original", "bytes"], Buffer.from("Original H0 bytes"))
  })
  const base = await capture("h0")
  await source.run(async () => {
    for (const [index, key] of references.entries())
      await Storage.writeBinary(key, Buffer.alloc(65539 + index, 65 + index))
  })
  const namespace = await capture("h1")
  const home = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "restoration-artifacts-")))
  const request = HomeRestoration.Request.parse({
    restoreID: crypto.randomUUID(),
    owner: "organization-runtime",
    sourceHash: digest(base.expected),
    payload: {},
  })
  const targetNamespace = "restoration-" + crypto.randomUUID()
  const open = async () => {
    const runtime = await storageTestRuntime({ home })
    runtime.run(() => {
      HomeRestoration.register()
      RuntimeMaintenance.registerProtection()
      RuntimeContext.sealComposition()
    })
    const store = await TransactionalStore.open(
      storageTestOptions({
        filename: path.join(home, ".synergy", "data", "target.sqlite"),
        namespace: targetNamespace,
      }),
    )
    const lock = await runtime.run(async () => {
      RuntimeContext.current().storage = { store, artifactDirectory: path.join(home, ".synergy", "data", "artifacts") }
      return ServerProcessLock.acquire()
    })
    return {
      store,
      run: runtime.run,
      async withTarget<T>(body: (permit: HomeRestoration.InstallPermit) => Promise<T>) {
        return runtime.run(async () => {
          const target = await HomeRestoration.begin(request)
          return HomeRestoration.withTarget(target, async (permit) => {
            await HomeRestoration.installOwner(permit, {
              identity: "a".repeat(64),
              readerContract: "native-artifact-fixture-v1",
            })
            return body(permit)
          })
        })
      },
      async close() {
        await store.close()
        await runtime.run(() => lock.release())
        await runtime.close()
      },
    }
  }
  const target = await open()
  await target.withTarget((permit) =>
    StorageCheckpoint.restoreArchive({
      ...base,
      keys,
      restoreID: request.restoreID,
      finalize: (tx, archive) => RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive }).then(() => {}),
    }),
  )
  return {
    target,
    open,
    base,
    namespace,
    keys,
    request,
    references,
    capture,
    input(permit: HomeRestoration.InstallPermit) {
      return { permit, request, base: base.expected, namespace, keys, references }
    },
    async [Symbol.asyncDispose]() {
      material.fill(0)
      await source.close()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test("a nonempty held restoration stages fixed H1 bytes and publishes only its original aliases", async () => {
  await using f = await fixture()
  try {
    let expired: StorageCheckpoint.PreparedArtifacts | undefined
    await f.target.withTarget(async (permit) => {
      await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async (prepared) => {
        expired = prepared
        const staged = await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })
        expect(staged).toHaveLength(3)
        for (const entry of staged)
          expect(StorageCheckpoint.acceptsStagedArtifact(prepared, entry.key, entry.location)).toBe(true)
        const first = staged[0]
        if (!first) throw new Error("Original native stage was not retained")
        expect(() =>
          Storage.provide(
            { ...Storage.current(), artifactDirectory: Storage.current().artifactDirectory + "-foreign" },
            () => StorageCheckpoint.acceptsStagedArtifact(prepared, first.key, first.location),
          ),
        ).toThrow()
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        expect(await Storage.read(["original", "sentinel"])).toEqual({ retained: true })
        await expect(Storage.transaction(() => Storage.write(["ordinary", "unsafe"], true))).rejects.toThrow()
        await RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, async (tx) => {
          await StorageCheckpoint.publishPreparedArtifacts(prepared, tx)
          await Storage.write(["recovery", "receipt"], { retained: true })
        })
      })
      expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 1 })).toEqual([])
      for (const [index, key] of references.entries())
        expect(Buffer.from(await Storage.readBinary(key))).toEqual(Buffer.alloc(65539 + index, 65 + index))
      expect(Buffer.from(await Storage.readBinary(["original", "bytes"]))).toEqual(Buffer.from("Original H0 bytes"))
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      const retained = expired
      if (!retained) throw new Error("The actual native preparation was not captured")
      const aliases = await Storage.artifactReferences({ prefix: ["new"], limit: 10 })
      await expect(
        RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, (tx) =>
          StorageCheckpoint.publishPreparedArtifacts(retained, tx),
        ),
      ).rejects.toBeInstanceOf(StorageConflictError)
      expect(await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).toEqual(aliases)
    })
  } finally {
    await f.target.close()
  }
}, 30_000)

test("unknown preparation commits retain their last native pin and exact H1 staging reopens cold", async () => {
  await using f = await fixture()
  let closed = false
  try {
    await f.target.withTarget(async (permit) => {
      const transaction = f.target.store.transaction.bind(f.target.store)
      const unknown = new StorageCommitUnknownError(undefined, new Error("Committed native artifact ACK was lost"))
      let committed = false
      {
        using lost = spyOn(f.target.store, "transaction").mockImplementation(
          async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
            const result = await transaction(body, options)
            const staged = await f.target.store.snapshot((tx) =>
              tx.artifactPage({ prefix: ["storage_checkpoint_staging"], limit: 1 }),
            )
            if (!committed && staged.length) {
              committed = true
              throw unknown
            }
            return result
          },
        )
        await expect(RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async () => {})).rejects.toBe(unknown)
      }
      expect(committed).toBe(true)
      const retained = (await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 1 }))[0]
      if (!retained) throw new Error("The committed unknown stage was not retained")
      const filename = path.join(Storage.current().artifactDirectory, "agent-artifacts", retained.location.pack)
      await RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, (tx) =>
        tx.removeTree(retained.key),
      )
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      expect((await fs.stat(filename)).isFile()).toBe(true)
      await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async () => {})
      expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toHaveLength(3)
    })
    await f.target.close()
    closed = true
    const cold = await f.open()
    try {
      await cold.withTarget(async (permit) => {
        const prepare = Storage.prepareBinaryStream
        let calls = 0
        using inspect = spyOn(Storage, "prepareBinaryStream").mockImplementation(async (...args) => {
          calls++
          return prepare(...args)
        })
        await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), (prepared) =>
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, (tx) =>
            StorageCheckpoint.publishPreparedArtifacts(prepared, tx),
          ),
        )
        expect(calls).toBe(0)
        expect((await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).length).toBe(3)
      })
    } finally {
      await cold.close()
    }
  } finally {
    if (!closed) await f.target.close()
  }
}, 30_000)

test("skipped or caught native alias writes cannot commit and exact staging survives a cold retry", async () => {
  await using f = await fixture()
  let closed = false
  try {
    await f.target.withTarget(async (permit) => {
      await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async (prepared) => {
        const staged = await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, () =>
            Storage.write(["recovery", "skipped"], true),
          ),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect((await Storage.readMany([["recovery", "skipped"]]))[0]).toBeUndefined()
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        const original = Storage.publishBinaryReference
        const failure = new Error("Alias effect failed after its actual staged write")
        using fault = spyOn(Storage, "publishBinaryReference").mockImplementation(async (...args) => {
          await original(...args)
          throw failure
        })
        let caught = 0
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, async (tx) => {
            try {
              await StorageCheckpoint.publishPreparedArtifacts(prepared, tx)
            } catch (error) {
              if (error !== failure) throw error
              caught++
            }
          }),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect(caught).toBe(1)
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        expect(await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).toEqual([])
      })
      expect(await Storage.artifactReferences({ prefix: ["new"], limit: 1 })).toEqual([])
      expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toHaveLength(3)
    })
    await f.target.close()
    closed = true
    const another = await f.capture("another-h1")
    const cold = await f.open()
    try {
      await cold.withTarget(async (permit) => {
        const first = references[0]
        if (!first) throw new Error("Original selected native artifact is missing")
        const staged = await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })
        await expect(
          RuntimeMaintenance.withRestorationArtifacts({ ...f.input(permit), references: [first] }, async () => {}),
        ).rejects.toBeInstanceOf(StorageIntegrityError)
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        await expect(
          RuntimeMaintenance.withRestorationArtifacts({ ...f.input(permit), namespace: another }, async () => {}),
        ).rejects.toBeInstanceOf(StorageIntegrityError)
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), (prepared) =>
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, (tx) =>
            StorageCheckpoint.publishPreparedArtifacts(prepared, tx),
          ),
        )
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 1 })).toEqual([])
        expect((await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).length).toBe(3)
      })
    } finally {
      await cold.close()
    }
  } finally {
    if (!closed) await f.target.close()
  }
}, 30_000)

test("artifact preparation rejects a different H0 manifest or H1 namespace before native staging", async () => {
  await using f = await fixture()
  try {
    await f.target.withTarget(async (permit) => {
      await expect(
        RuntimeMaintenance.withRestorationArtifacts(
          { ...f.input(permit), base: { ...f.base.expected, namespaceID: "foreign" } },
          async () => {},
        ),
      ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      await expect(
        RuntimeMaintenance.withRestorationArtifacts(
          {
            ...f.input(permit),
            namespace: { ...f.namespace, expected: { ...f.namespace.expected, namespaceID: "foreign" } },
          },
          async () => {},
        ),
      ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 1 })).toEqual([])
    })
  } finally {
    await f.target.close()
  }
}, 30_000)

test("another genuine same-content native location cannot replace the verified stage witness", async () => {
  await using f = await fixture()
  try {
    await f.target.withTarget(async (permit) => {
      const bytes = Buffer.alloc(65539, 65)
      const alternateKey = ["native", "alternate"]
      using alternate = await Storage.prepareBinary(alternateKey, bytes)
      await RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, () =>
        Storage.publishPreparedBinary(alternate),
      )
      const location = (await Storage.artifactReferences({ prefix: alternateKey, limit: 1 }))[0]?.location
      if (!location) throw new Error("The actual alternate native bytes were not published")
      expect(Buffer.from(await Storage.readBinary(alternateKey))).toEqual(bytes)
      await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async (prepared) => {
        const staged = await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })
        const original = staged.find((entry) => entry.location.sha256 === location.sha256)
        if (!original) throw new Error("The original same-content stage was not prepared")
        expect(original.location.size).toBe(location.size)
        expect(original.location).not.toEqual(location)
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, async (tx) => {
            await Storage.publishBinaryReference(alternateKey, original.key, { replace: true })
            await StorageCheckpoint.publishPreparedArtifacts(prepared, tx)
          }),
        ).rejects.toBeInstanceOf(StorageIntegrityError)
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        expect(await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).toEqual([])
      })
    })
  } finally {
    await f.target.close()
  }
}, 30_000)

test("a caught foreign sibling stage write after alias publication cannot commit", async () => {
  await using f = await fixture()
  try {
    await f.target.withTarget(async (permit) => {
      await RuntimeMaintenance.withRestorationArtifacts(f.input(permit), async (prepared) => {
        const staged = await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })
        const source = references[0]
        if (!source) throw new Error("The original native alias key is missing")
        let caught: unknown
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit, request: f.request }, async (tx) => {
            await StorageCheckpoint.publishPreparedArtifacts(prepared, tx)
            try {
              await Storage.publishBinaryReference(source, [
                "storage_checkpoint_staging",
                f.request.restoreID,
                "foreign",
              ])
            } catch (error) {
              caught = error
            }
          }),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect(caught).toBeInstanceOf(StorageConflictError)
        expect(await Storage.artifactReferences({ prefix: ["storage_checkpoint_staging"], limit: 10 })).toEqual(staged)
        expect(await Storage.artifactReferences({ prefix: ["new"], limit: 10 })).toEqual([])
      })
    })
  } finally {
    await f.target.close()
  }
}, 30_000)

import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { HomeRestoration } from "../../src/lifecycle/home-restoration"
import { RuntimeContext } from "../../src/lifecycle/context"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Storage } from "../../src/storage/storage"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { testRuntime } from "../support/runtime"
import { storageTestRuntime } from "../support/storage-runtime"

const manifestHash = (value: StorageCheckpoint.Manifest) =>
  createHash("sha256")
    .update(JSON.stringify(StorageCheckpoint.Manifest.parse(value)))
    .digest("hex")
async function targetFixture(home?: string) {
  const selected = await fs.realpath(
    home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "maintenance-adoption-"))),
  )
  const runtime = await storageTestRuntime({ home: selected })
  runtime.run(() => {
    HomeRestoration.register()
    RuntimeMaintenance.registerProtection()
    RuntimeContext.sealComposition()
  })
  const root = path.join(selected, ".synergy")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(root, "data", "restore.sqlite"),
    namespace: "target",
  })
  const lock = await runtime.run(async () => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
    return ServerProcessLock.acquire()
  })
  return {
    home: selected,
    root,
    store,
    run: runtime.run,
    async close() {
      await store.close()
      await runtime.run(() => lock.release())
      await runtime.close()
    },
  }
}
async function sourceFixture() {
  const runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({
        required: ["sessions", "loop-jobs", "environments", "workspace-mounts", "workspace-operations"],
      })
    },
  })
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const directory = path.join(runtime.host.home, "archive")
  const captured = await runtime.run(async () => {
    await Storage.write(["canonical", "history"], { future: { retained: true } })
    await Storage.writeBinary(["canonical", "bytes"], Buffer.from("Exact imported bytes"))
    const requestID = "source-backup"
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID,
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Native fixture operator",
        clientKind: "system",
        requestID,
      },
    })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const source = await RuntimeMaintenance.status()
    const manifest = await RuntimeMaintenance.withFrozen(lease, () =>
      StorageCheckpoint.exportArchive({
        directory,
        keys,
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        protect: () => true,
      }),
    )
    return { source: source!, manifest, lease }
  })
  return {
    ...captured,
    directory,
    keys,
    async close() {
      key.fill(0)
      await runtime.close()
    },
  }
}

test("raw namespace restoration atomically retains source maintenance history and publishes a distinct recovery-held target", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const request = HomeRestoration.Request.parse({
    restoreID: "restore-maintenance",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: { namespace: "fixture" },
  })
  let closed = false
  let installationID = ""
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        installationID = HomeRestoration.describe(permit).installationID
        const failure = new Error("finalization failed after native hold adoption")
        const restore = (fail: boolean) =>
          StorageCheckpoint.restoreArchive({
            directory: source.directory,
            expected: source.manifest,
            keys: source.keys,
            restoreID: request.restoreID,
            commitGuard() {
              HomeRestoration.assertCurrent(permit)
              HomeRestoration.assertRequest(permit, request)
            },
            async finalize(tx, archive) {
              const held = await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
              expect(held.phase).toBe("recovery-held")
              if (fail) throw failure
            },
          })
        await expect(restore(true)).rejects.toBe(failure)
        expect(await RuntimeMaintenance.status()).toBeUndefined()
        expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
        await restore(false)
        expect((await RuntimeMaintenance.status())?.maintenanceID).toBe(installationID)
        expect((await RuntimeMaintenance.status())?.purpose).toBe("organization-restore")
        expect(await RuntimeMaintenance.operation(source.source.maintenanceID)).toEqual(source.source)
        expect(await Storage.read(["canonical", "history"])).toEqual({ future: { retained: true } })
        expect(await Storage.readBinary(["canonical", "bytes"])).toEqual(Buffer.from("Exact imported bytes"))
        await expect(RuntimeMaintenance.release(source.lease)).rejects.toThrow()
        await expect(
          RuntimeMaintenance.release({ maintenanceID: installationID, purpose: "organization-restore" }),
        ).rejects.toThrow()
      })
    })
    await target.close()
    closed = true
    const cold = await targetFixture(target.home)
    try {
      await cold.run(async () => {
        expect((await RuntimeMaintenance.status())?.maintenanceID).toBe(installationID)
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
        await expect(Storage.write(["canonical", "unsafe"], { changed: true })).rejects.toThrow()
        expect(await RuntimeMaintenance.operation(source.source.maintenanceID)).toEqual(source.source)
      })
    } finally {
      await cold.close()
    }
  } finally {
    await source.close()
    if (!closed) await target.close()
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

test("native import evidence rejects fake, snapshot, foreign and expired transaction consumers", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(target.home, "foreign.sqlite"),
    namespace: "foreign",
  })
  const request = HomeRestoration.Request.parse({
    restoreID: "evidence-lifetime",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        let expired: { tx: StoreTransaction; archive: StorageCheckpoint.ImportEvidence } | undefined
        let guarded = 0
        await StorageCheckpoint.restoreArchive({
          directory: source.directory,
          expected: source.manifest,
          restoreID: request.restoreID,
          keys: source.keys,
          async finalize(tx, archive) {
            expired = { tx, archive }
            expect(StorageCheckpoint.assertImport(archive, tx)).toEqual(source.manifest)
            expect(archive.restoreID).toBe(request.restoreID)
            expect(() => StorageCheckpoint.assertImport({ ...archive }, tx)).toThrow("native evidence")
            expect(() => StorageCheckpoint.guardImport({ ...archive }, tx, () => {})).toThrow("native evidence")
            StorageCheckpoint.guardImport(archive, tx, () => {
              guarded++
              HomeRestoration.assertInstalledOwner(permit)
              HomeRestoration.assertRequest(permit, request)
            })
            await expect(
              RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive: { ...archive } }),
            ).rejects.toThrow("native evidence")
            await target.store.snapshot(async (snapshot) => {
              expect(() => StorageCheckpoint.assertImport(archive, snapshot)).toThrow("transaction")
            })
            await foreign.transaction(async (other) => {
              expect(() => StorageCheckpoint.assertImport(archive, other)).toThrow("transaction")
            })
            const first = await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
            expect(await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })).toEqual(first)
          },
          commitGuard() {
            HomeRestoration.assertInstalledOwner(permit)
            HomeRestoration.assertRequest(permit, request)
          },
        })
        if (!expired) throw new Error("Fixture did not receive original import evidence")
        const closed = expired
        expect(() => StorageCheckpoint.assertImport(closed.archive, closed.tx)).toThrow("closed")
        expect(guarded).toBeGreaterThan(0)
        expect(() => StorageCheckpoint.guardImport(closed.archive, closed.tx, () => {})).toThrow("closed")
        await expect(
          RuntimeMaintenance.adoptRestoration(expired.tx, { permit, request, archive: expired.archive }),
        ).rejects.toThrow()
      })
    })
  } finally {
    await foreign.close()
    await Promise.all([source.close(), target.close()])
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

test("cancellation after the last raw cleanup write rolls back the imported namespace and recovery hold together", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const request = HomeRestoration.Request.parse({
    restoreID: "last-write-abort",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        const controller = new AbortController()
        const reason = new Error("cancel after actual last raw import write")
        const remove = StoreTransaction.prototype.removeTree
        const barrier = spyOn(StoreTransaction.prototype, "removeTree").mockImplementation(async function (
          this: StoreTransaction,
          prefix,
        ) {
          const result = await remove.call(this, prefix)
          if (prefix[0] === "storage_checkpoint_staging") controller.abort(reason)
          return result
        })
        try {
          await expect(
            StorageCheckpoint.restoreArchive({
              directory: source.directory,
              expected: source.manifest,
              keys: source.keys,
              restoreID: request.restoreID,
              signal: controller.signal,
              commitGuard() {
                HomeRestoration.assertInstalledOwner(permit)
                HomeRestoration.assertRequest(permit, request)
              },
              async finalize(tx, archive) {
                await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
              },
            }),
          ).rejects.toBe(reason)
        } finally {
          barrier.mockRestore()
        }
        expect(await RuntimeMaintenance.status()).toBeUndefined()
        expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
        expect(await RuntimeMaintenance.restoration(HomeRestoration.describe(permit).installationID)).toBeUndefined()
        expect(await target.store.operationReceipt(`storage-checkpoint:${request.restoreID}`)).toBeUndefined()
        await StorageCheckpoint.restoreArchive({
          directory: source.directory,
          expected: source.manifest,
          keys: source.keys,
          restoreID: request.restoreID,
          commitGuard() {
            HomeRestoration.assertInstalledOwner(permit)
            HomeRestoration.assertRequest(permit, request)
          },
          async finalize(tx, archive) {
            await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
          },
        })
        expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      })
    })
  } finally {
    await Promise.all([source.close(), target.close()])
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

test("an existing format-three marker cannot replace fresh native owner verification before raw import", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const request = HomeRestoration.Request.parse({
    restoreID: "verify-before-import",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      const marker = await HomeRestoration.withTarget(selected, (permit) =>
        HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        }),
      )
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.assertPendingOwner(marker)
        const restore = () =>
          StorageCheckpoint.restoreArchive({
            directory: source.directory,
            expected: source.manifest,
            keys: source.keys,
            restoreID: request.restoreID,
            commitGuard() {
              HomeRestoration.assertInstalledOwner(permit)
              HomeRestoration.assertRequest(permit, request)
            },
            async finalize(tx, archive) {
              await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
            },
          })
        await expect(restore()).rejects.toThrow("freshly verified")
        expect(await RuntimeMaintenance.status()).toBeUndefined()
        expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
        await HomeRestoration.verifyInstalledOwner(permit)
        await restore()
        expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      })
    })
  } finally {
    await Promise.all([source.close(), target.close()])
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

test("a valid fixed namespace without an actual frozen source operation cannot seed a recovery baseline", async () => {
  const source = await targetFixture()
  const target = await targetFixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const directory = path.join(source.home, "archive")
  try {
    const manifest = await source.run(async () => {
      await Storage.write(["canonical", "unheld"], { retained: true })
      return StorageCheckpoint.exportArchive({
        directory,
        archiveID: "unheld",
        namespaceID: "runtime",
        keys,
        buildVersion: "fixture",
        protect: () => true,
      })
    })
    const request = HomeRestoration.Request.parse({
      restoreID: "no-frozen-source",
      owner: "organization-runtime",
      sourceHash: manifestHash(manifest),
      payload: {},
    })
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        await expect(
          StorageCheckpoint.restoreArchive({
            directory,
            expected: manifest,
            keys,
            restoreID: request.restoreID,
            commitGuard() {
              HomeRestoration.assertInstalledOwner(permit)
              HomeRestoration.assertRequest(permit, request)
            },
            async finalize(tx, archive) {
              await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
            },
          }),
        ).rejects.toThrow("frozen source")
        expect(await RuntimeMaintenance.status()).toBeUndefined()
        expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
        expect(await RuntimeMaintenance.restoration(HomeRestoration.describe(permit).installationID)).toBeUndefined()
      })
    })
  } finally {
    key.fill(0)
    await Promise.all([source.close(), target.close()])
    await Promise.all([source.home, target.home].map((home) => fs.rm(home, { recursive: true, force: true })))
  }
}, 15_000)

test("ending the actual Home callback before the delayed raw commit refuses the entire restoration", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const request = HomeRestoration.Request.parse({
    restoreID: "ended-home-callback",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let restoration: Promise<unknown> | undefined
  let expired: HomeRestoration.InstallPermit | undefined
  const remove = StoreTransaction.prototype.removeTree
  const barrier = spyOn(StoreTransaction.prototype, "removeTree").mockImplementation(async function (
    this: StoreTransaction,
    prefix,
  ) {
    const result = await remove.call(this, prefix)
    if (prefix[0] === "storage_checkpoint_staging") {
      entered.resolve()
      await release.promise
    }
    return result
  })
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        expired = permit
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        restoration = StorageCheckpoint.restoreArchive({
          directory: source.directory,
          expected: source.manifest,
          keys: source.keys,
          restoreID: request.restoreID,
          async finalize(tx, archive) {
            await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        await entered.promise
      })
      expect(() => HomeRestoration.assertCurrent(expired!)).toThrow("callback")
      release.resolve()
      const outcome = await restoration
      expect(outcome).toBeInstanceOf(Error)
      expect(String(outcome)).toContain("callback")
      expect(await RuntimeMaintenance.status()).toBeUndefined()
      expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
      expect(await target.store.operationReceipt(`storage-checkpoint:${request.restoreID}`)).toBeUndefined()
    })
  } finally {
    release.resolve()
    await restoration
    barrier.mockRestore()
    await Promise.all([source.close(), target.close()])
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

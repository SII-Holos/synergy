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
async function targetFixture(home?: string, publication = false) {
  const selected = await fs.realpath(
    home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "maintenance-adoption-"))),
  )
  const runtime = await storageTestRuntime({ home: selected })
  runtime.run(() => {
    HomeRestoration.register()
    RuntimeMaintenance.registerProtection()
    if (publication)
      HomeRestoration.registerPublicationOwner("organization-runtime", {
        async read(info) {
          const row = await Storage.read<{ hash: string; settingsHash: string; installationID: string }>([
            "publication",
            info.installationID,
          ])
          if (row.installationID !== info.installationID) throw new Error("Publication belongs to another installation")
          const file = Bun.file(path.join(selected, "current-settings.json"))
          return {
            publicationHash: row.hash,
            nativeReady:
              (await file.exists()) &&
              createHash("sha256")
                .update(await file.bytes())
                .digest("hex") === row.settingsHash,
            released: (await RuntimeMaintenance.status())?.phase === "released",
          }
        },
      })
    RuntimeContext.sealComposition()
  })
  const root = path.join(selected, ".synergy")
  if (publication && (await Bun.file(path.join(root, "home-restoration.json")).exists()))
    await runtime.run(async () => expect((await HomeRestoration.inspectCompleted()).phase).toBe("completed"))
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

test("only a committed publication with current native settings completes and releases the original restored Home", async () => {
  const source = await sourceFixture()
  const target = await targetFixture(undefined, true)
  const request = HomeRestoration.Request.parse({
    restoreID: "complete-original-recovery",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  const hash = "f".repeat(64)
  const settings = Buffer.from('{"current":"H1"}\n')
  let installationID = ""
  let expired: HomeRestoration.PublicationPermit | undefined
  let targetClosed = false
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(selected, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        installationID = HomeRestoration.describe(permit).installationID
        await StorageCheckpoint.restoreArchive({
          directory: source.directory,
          expected: source.manifest,
          keys: source.keys,
          restoreID: request.restoreID,
          finalize: (tx, archive) =>
            RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive }).then(() => {}),
        })
        await RuntimeMaintenance.restorationTransaction({ permit, request }, () =>
          Storage.write(["publication", installationID], {
            hash,
            installationID,
            settingsHash: createHash("sha256").update(settings).digest("hex"),
          }),
        )
      })
      await expect(
        HomeRestoration.withPublication({ installationID, publicationHash: "e".repeat(64) }, async () => {}),
      ).rejects.toThrow()
      await expect(
        Storage.transaction(() =>
          HomeRestoration.withPublication({ installationID, publicationHash: hash }, async () => {}),
        ),
      ).rejects.toThrow("committed")
      await HomeRestoration.withPublication({ installationID, publicationHash: hash }, async (permit) => {
        expired = permit
        await expect(HomeRestoration.completePublication(permit)).rejects.toThrow("native")
        await expect(RuntimeMaintenance.releaseRestoration(permit)).rejects.toThrow()
        await Bun.write(path.join(target.home, "current-settings.json"), settings)
      })
      const intent = path.join(target.root, "home-restoration.json")
      const originalOpen = fs.open
      const partial = new Error("Interrupted completion tail")
      using interrupted = spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = await originalOpen(...args)
        if (String(args[0]) === intent && typeof args[1] === "number" && (args[1] & 2) === 2) {
          const write = file.write.bind(file)
          spyOn(file, "write").mockImplementation((async (
            buffer: NodeJS.ArrayBufferView | string,
            offset?: number | null,
            length?: number | null,
            position?: number | null,
          ) => {
            if (typeof buffer === "string") throw new Error("Completion requires bounded bytes")
            if (typeof offset !== "number" || typeof length !== "number" || typeof position !== "number")
              throw new Error("Completion requires its explicit original offset")
            await write(buffer, offset, Math.min(17, length), position)
            throw partial
          }) as typeof file.write)
        }
        return file
      })
      await expect(
        HomeRestoration.withPublication({ installationID, publicationHash: hash }, HomeRestoration.completePublication),
      ).rejects.toBe(partial)
      interrupted.mockRestore()
      await expect(HomeRestoration.assertOrdinaryStartup()).rejects.toThrow()
      const lost = new Error("Completion sync acknowledgement lost")
      using unknown = spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = await originalOpen(...args)
        if (String(args[0]) === intent && typeof args[1] === "number" && (args[1] & 2) === 2) {
          const sync = file.sync.bind(file)
          spyOn(file, "sync").mockImplementation(async () => {
            await sync()
            throw lost
          })
        }
        return file
      })
      await expect(
        HomeRestoration.withPublication({ installationID, publicationHash: hash }, HomeRestoration.completePublication),
      ).rejects.toBe(lost)
      unknown.mockRestore()
      await expect(HomeRestoration.assertOrdinaryStartup()).rejects.toThrow()
      const entered = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      const originalWrite = StoreTransaction.prototype.write
      using delayed = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
        this: StoreTransaction,
        key,
        value,
      ) {
        await originalWrite.call(this, key, value)
        const next = RuntimeMaintenance.Info.safeParse(value)
        if (next.success && next.data.maintenanceID === installationID && next.data.phase === "released") {
          entered.resolve()
          await finish.promise
        }
      })
      let pending: Promise<RuntimeMaintenance.Info> | undefined
      await HomeRestoration.withPublication({ installationID, publicationHash: hash }, async (permit) => {
        pending = RuntimeMaintenance.releaseRestoration(permit)
        void pending.catch(() => {})
        await entered.promise
      })
      finish.resolve()
      await expect(pending!).rejects.toThrow("callback")
      delayed.mockRestore()
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      await HomeRestoration.withPublication({ installationID, publicationHash: hash }, async (permit) => {
        await HomeRestoration.completePublication(permit)
        const retained = await RuntimeMaintenance.restoration(installationID)
        expect((await RuntimeMaintenance.releaseRestoration(permit)).phase).toBe("released")
        expect(await RuntimeMaintenance.restoration(installationID)).toEqual(retained)
        expect(await RuntimeMaintenance.operation(source.source.maintenanceID)).toEqual(source.source)
      })
      await HomeRestoration.assertOrdinaryStartup()
      await Storage.write(["canonical", "ready"], true)
      expect(() => HomeRestoration.assertPublication(expired!)).toThrow("callback")
      await expect(RuntimeMaintenance.releaseRestoration({ kind: "home-publication" })).rejects.toThrow()
    })
    await target.close()
    targetClosed = true
    const cold = await targetFixture(target.home, true)
    try {
      await cold.run(async () => {
        await HomeRestoration.assertOrdinaryStartup()
        await RuntimeMaintenance.assertAdmission()
        expect(await Storage.read(["canonical", "ready"])).toBe(true)
        await HomeRestoration.withPublication({ installationID, publicationHash: hash }, async (permit) => {
          await HomeRestoration.completePublication(permit)
          expect((await RuntimeMaintenance.releaseRestoration(permit)).phase).toBe("released")
        })
      })
    } finally {
      await cold.close()
    }
  } finally {
    await source.close()
    if (!targetClosed) await target.close()
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15000)
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

test("recovery history transactions retain native ownership and the execution hold through their final commit", async () => {
  const source = await sourceFixture()
  const target = await targetFixture()
  const request = HomeRestoration.Request.parse({
    restoreID: "recovery-history",
    owner: "organization-runtime",
    sourceHash: manifestHash(source.manifest),
    payload: {},
  })
  let expired: HomeRestoration.InstallPermit | undefined
  let pending: Promise<unknown> | undefined
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const write = StoreTransaction.prototype.write
  const barrier = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
    this: StoreTransaction,
    key,
    value,
  ) {
    const result = await write.call(this, key, value)
    if (key[0] === "canonical" && key[1] === "delayed-policy") {
      entered.resolve()
      await finish.promise
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
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit, request }, async () => {
            throw new Error("An unadopted target must not invoke its writer")
          }),
        ).rejects.toThrow("retained native installation")
        await StorageCheckpoint.restoreArchive({
          directory: source.directory,
          expected: source.manifest,
          keys: source.keys,
          restoreID: request.restoreID,
          async finalize(tx, archive) {
            await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
          },
        })
        const held = await RuntimeMaintenance.status()
        await expect(Storage.write(["canonical", "policy"], { unsafe: true })).rejects.toThrow()
        await expect(
          RuntimeMaintenance.restorationTransaction({ permit: { ...permit }, request }, async () => {}),
        ).rejects.toThrow()
        await expect(
          Storage.transaction(() => RuntimeMaintenance.restorationTransaction({ permit, request }, async () => {})),
        ).rejects.toThrow("transaction")
        await RuntimeMaintenance.restorationTransaction({ permit, request }, async (tx) => {
          target.store.assertWriteTransaction(tx)
          await Storage.write(["canonical", "policy"], { revision: 1 })
          await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
          await expect(Storage.write(["runtime_maintenance", "current"], { maintenanceID: "forged" })).rejects.toThrow()
        })
        expect(await Storage.read(["canonical", "policy"])).toEqual({ revision: 1 })
        expect(await RuntimeMaintenance.status()).toEqual(held)
        const failure = new Error("native recovery history final commit refused")
        await expect(
          RuntimeMaintenance.restorationTransaction(
            { permit, request },
            async () => {
              await Storage.write(["canonical", "policy"], { revision: 2 })
              await Storage.write(["canonical", "publication-receipt"], { published: true })
            },
            {
              commitGuard() {
                throw failure
              },
            },
          ),
        ).rejects.toBe(failure)
        expect(await Storage.read(["canonical", "policy"])).toEqual({ revision: 1 })
        expect(await Storage.readMany([["canonical", "publication-receipt"]])).toEqual([undefined])
        expect(await RuntimeMaintenance.status()).toEqual(held)
        expect(await RuntimeMaintenance.operation(source.source.maintenanceID)).toEqual(source.source)
        const controller = new AbortController()
        const cancelled = new Error("recovery callback invalidated at final commit")
        await expect(
          RuntimeMaintenance.restorationTransaction(
            { permit, request },
            async () => {
              await Storage.write(["canonical", "policy"], { revision: 3 })
            },
            {
              signal: controller.signal,
              commitGuard() {
                controller.abort(cancelled)
              },
            },
          ),
        ).rejects.toBe(cancelled)
        expect(await Storage.read(["canonical", "policy"])).toEqual({ revision: 1 })
        await expect(Storage.write(["canonical", "policy"], { revision: 3 })).rejects.toThrow()
        pending = RuntimeMaintenance.restorationTransaction({ permit, request }, async () => {
          await Storage.write(["canonical", "delayed-policy"], { revision: 4 })
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        await entered.promise
      })
      finish.resolve()
      const outcome = await pending
      expect(outcome).toBeInstanceOf(Error)
      expect(String(outcome)).toContain("callback")
      expect(await Storage.readMany([["canonical", "delayed-policy"]])).toEqual([undefined])
      await expect(
        RuntimeMaintenance.restorationTransaction({ permit: expired!, request }, async () => {}),
      ).rejects.toThrow("callback")
      await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    })
  } finally {
    finish.resolve()
    await pending
    barrier.mockRestore()
    await Promise.all([source.close(), target.close()])
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

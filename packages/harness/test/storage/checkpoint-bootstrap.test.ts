import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Storage } from "../../src/storage/storage"
import { RuntimeContext } from "../../src/lifecycle/context"
import { storageTestRuntime } from "../support/storage-runtime"

const keys = {
  async current() {
    return { version: "test", key: Buffer.alloc(32, 18) }
  },
  async resolve() {
    return Buffer.alloc(32, 18)
  },
}
async function fixture(defer = false) {
  const runtime = await storageTestRuntime({ environment: { SYNERGY_STORAGE_COMPAT_DEFER: defer ? "1" : "0" } })
  const prepared = await runtime.run(async () => {
    const selected = await StorageBootstrap.prepare({
      root: RuntimeContext.current().host.root,
      async beforeInitialize(store) {
        const owner = RuntimeContext.current()
        owner.storage = { store, artifactDirectory: path.join(owner.host.root, "data") }
        expect(await store.snapshot((tx) => tx.queryKeys({ prefix: [], limit: 1 }))).toEqual([])
      },
    })
    await selected.activate()
    return selected
  })
  return {
    ...prepared,
    run: runtime.run,
    async [Symbol.asyncDispose]() {
      await prepared.store.close()
      await runtime.close()
    },
  }
}

test("a checkpoint preserves the actual fresh target bootstrap identity while authenticating the complete source archive", async () => {
  await using source = await fixture()
  await using target = await fixture(true)
  const identity = await target.store.read(["storage_meta", "identity"])
  const archive = await source.run(async () => {
    await Storage.write(["canonical", "value"], { actual: "source" })
    const directory = path.join(RuntimeContext.current().host.home, "archive")
    const manifest = await StorageCheckpoint.exportArchive({
      directory,
      archiveID: "source",
      namespaceID: "source",
      buildVersion: "test",
      keys,
      protect: () => true,
    })
    return { directory, manifest }
  })
  const file = Bun.file(path.join(archive.directory, "records.ndjson"))
  const digest = createHash("sha256")
    .update(await file.bytes())
    .digest("hex")
  await target.run(async () => {
    const input = {
      directory: archive.directory,
      expected: archive.manifest,
      keys,
      restoreID: "target",
      async finalize() {},
    }
    await expect(StorageCheckpoint.restoreArchive(input)).rejects.toThrow("empty namespace")
    await target.withRestorationBase((base) => StorageCheckpoint.restoreArchive({ ...input, base }))
    expect(await Storage.read(["canonical", "value"])).toEqual({ actual: "source" })
    expect(await Storage.read(["storage_meta", "identity"])).toEqual(identity)
    expect(await Storage.read(["compat_import", "info"])).toMatchObject({
      counts: { pending: 0, partial: 0, imported: 0, quarantined: 0, total: 0 },
      discovered: true,
    })
  })
  expect(
    createHash("sha256")
      .update(await file.bytes())
      .digest("hex"),
  ).toBe(digest)
})

test("a bootstrap base rejects occupied namespaces, changed original rows and swallowed writes to its native identity", async () => {
  await using source = await fixture()
  await using target = await fixture()
  await using unchanged = await fixture()
  const archive = await source.run(async () => {
    await Storage.write(["canonical", "value"], { actual: "source" })
    const directory = path.join(RuntimeContext.current().host.home, "archive")
    const manifest = await StorageCheckpoint.exportArchive({
      directory,
      archiveID: "source",
      namespaceID: "source",
      buildVersion: "test",
      keys,
      protect: () => true,
    })
    return { directory, manifest }
  })
  await source.run(() => expect(source.withRestorationBase(async () => {})).rejects.toThrow("base"))
  await target.run(async () => {
    await target.withRestorationBase(async (base) => {
      await Storage.write(["storage_meta", "identity"], { changed: true })
      await expect(
        StorageCheckpoint.restoreArchive({
          directory: archive.directory,
          expected: archive.manifest,
          keys,
          restoreID: "changed",
          base,
          async finalize() {},
        }),
      ).rejects.toThrow("base")
      expect((await Storage.readMany([["canonical", "value"]]))[0]).toBeUndefined()
    })
  })
  await unchanged.run(async () => {
    const original = await Storage.read(["storage_meta", "identity"])
    await unchanged.withRestorationBase(async (base) => {
      await expect(
        StorageCheckpoint.restoreArchive({
          directory: archive.directory,
          expected: archive.manifest,
          keys,
          restoreID: "swallowed",
          base,
          async finalize(tx) {
            try {
              await tx.write(["storage_meta", "identity"], { changed: true })
            } catch {}
          },
        }),
      ).rejects.toThrow("base")
      expect(await Storage.read(["storage_meta", "identity"])).toEqual(original)
      expect((await Storage.readMany([["canonical", "value"]]))[0]).toBeUndefined()
    })
  })
})

test("a prepared bootstrap cannot certify replaced metadata as its original empty base", async () => {
  await using target = await fixture()
  await target.run(async () => {
    await Storage.write(["storage_meta", "identity"], { changed: "after initialization" })
    await expect(target.withRestorationBase(async () => {})).rejects.toThrow("base")
  })
})

test("Bootstrap cannot certify unknown physical-prefix records written before its original initialization", async () => {
  const runtime = await storageTestRuntime()
  await using cleanup = { [Symbol.asyncDispose]: runtime.close }
  await runtime.run(async () => {
    let initialized: StorageBootstrap.Prepared | undefined
    try {
      await expect(
        (async () => {
          initialized = await StorageBootstrap.prepare({
            root: RuntimeContext.current().host.root,
            async beforeInitialize(store) {
              const owner = RuntimeContext.current()
              owner.storage = { store, artifactDirectory: path.join(owner.host.root, "data") }
              await store.write(["storage_meta", "unknown"], { retainedBusiness: true })
              await store.write(["storage_staging", "unfinished"], { phase: "pending" })
            },
          })
          await initialized.activate()
          await initialized.withRestorationBase(async () => {})
        })(),
      ).rejects.toThrow("base")
    } finally {
      await initialized?.store.close()
    }
  })
})

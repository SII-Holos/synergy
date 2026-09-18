import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { PackedLegacyImporter } from "../../src/storage/packed-import"
import { PackedBackup } from "../../src/storage/packed-backup"
import { StorageArtifactMigration } from "../../src/storage/artifact-migration"
import { ArtifactPack } from "../../src/storage/artifact-pack"
import { StoragePortable } from "../../src/storage/portable"

const owner = ["sessions", "scope", "owner"]
const key = [...owner, "rollout", "blobs", "large"]
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "large-artifact-"))
  const dataRoot = path.join(root, "data")
  await fs.mkdir(dataRoot)
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    process.env.SYNERGY_TEST_POSTGRES_URL
      ? { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL }
      : { backend: "sqlite", namespace, filename: path.join(root, "target.sqlite") },
  )
  return {
    root,
    dataRoot,
    store,
    artifactDirectory: dataRoot,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("binary evidence above 32 MiB remains readable, bounded by callers and fully verified", async () => {
  await using handle = await fixture()
  const bytes = Buffer.alloc(40 * 1024 ** 2, 71)
  await handle.store.write([...owner, "info"], { id: "owner" })
  await Storage.provide(handle, async () => {
    await Storage.writeBinary(key, bytes)
    const location = await handle.store.snapshot((tx) => tx.artifact(key))
    expect(location).toMatchObject({ codec: "raw", size: bytes.length })
    expect(await Storage.validateArtifacts(handle)).toBe(1)
    await expect(Storage.readBinary(key, { maxBytes: 32 * 1024 ** 2 })).rejects.toThrow("byte limit")
    expect(digest(await Storage.readBinary(key))).toBe(digest(bytes))
    const archive = path.join(handle.root, "records.ndjson")
    await StoragePortable.exportFile(handle.store, archive)
    await using target = await fixture()
    await fs.cp(path.join(handle.dataRoot, "agent-artifacts"), path.join(target.dataRoot, "agent-artifacts"), {
      recursive: true,
    })
    await StoragePortable.importFile(target.store, archive)
    expect(await Storage.validateArtifacts(target)).toBe(1)
    await Storage.writeBinary(key, bytes)
    const filename = path.join(handle.dataRoot, "agent-artifacts", location.pack)
    expect((await fs.stat(filename)).size).toBe(bytes.length)
    const pack = new ArtifactPack(path.dirname(filename))
    const tail = bytes.subarray(bytes.length - 4)
    expect(await pack.read({ ...location, offset: bytes.length - 4, size: 4, sha256: digest(tail) }, 4)).toEqual(
      new Uint8Array(tail),
    )
    await expect(pack.read({ ...location, codec: "gzip" })).rejects.toThrow("byte bounds")
    await expect(pack.read({ ...location, blockOffset: Number.MAX_SAFE_INTEGER })).rejects.toThrow("byte bounds")
    const file = await fs.open(filename, "r+")
    try {
      await file.write(Buffer.from([0]), 0, 1, bytes.length - 1)
    } finally {
      await file.close()
    }
    await expect(Storage.validateArtifacts(handle)).rejects.toThrow("content integrity")
  })
}, 20000)

for (const authority of ["json", "sql"] as const)
  test(`${authority} authority migrates and restores legacy binary evidence above 32 MiB`, async () => {
    await using handle = await fixture()
    const bytes = Buffer.alloc(40 * 1024 ** 2, 83)
    const info = { id: "owner", title: "Historical", scope: { id: "scope" }, time: { created: 1, updated: 2 } }
    const filename = path.join(handle.dataRoot, ...key) + ".bin"
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, bytes)
    let backupRoot: string
    if (authority === "json") {
      await fs.writeFile(path.join(handle.dataRoot, ...owner, "info.json"), JSON.stringify(info))
      backupRoot = path.join(handle.root, "backup")
      const importer = new PackedLegacyImporter({ ...handle, backupRoot })
      expect(await importer.run()).toMatchObject({ artifacts: 1, quarantined: 0 })
      expect(await Storage.validateArtifacts(handle)).toBe(1)
      await importer.retire()
    } else {
      await handle.store.write([...owner, "info"], info)
      await StorageArtifactMigration.run(handle)
      await StorageArtifactMigration.run(handle)
      backupRoot = path.join(handle.dataRoot, "storage", "backups", "artifacts-v2")
    }
    expect(await Bun.file(filename).exists()).toBe(false)
    await Storage.provide(handle, async () => expect(digest(await Storage.readBinary(key))).toBe(digest(bytes)))
    const restored = path.join(handle.root, "restored")
    await new PackedBackup({
      dataRoot: handle.dataRoot,
      backupRoot,
      selection: authority === "json" ? "home" : "artifacts",
    }).restore(restored)
    expect(digest(await fs.readFile(path.join(restored, ...key) + ".bin"))).toBe(digest(bytes))
  }, 20000)

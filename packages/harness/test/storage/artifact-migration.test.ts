import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageArtifactMigration } from "../../src/storage/artifact-migration"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("existing SQL authority upgrades loose rollout bytes before runtime admission and can resume", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-upgrade-"))
    const dataRoot = path.join(root, "data")
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "upgrade",
      filename: path.join(root, "data.sqlite"),
    })
    try {
      const key = ["sessions", "scope", "owner", "rollout", "blobs", "content"]
      await store.write(["sessions", "scope", "owner", "info"], { id: "owner" })
      const filename = path.join(dataRoot, ...key) + ".bin"
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.writeFile(filename, "historical bytes")
      let interrupted = false
      await expect(
        StorageArtifactMigration.run({
          dataRoot,
          store,
          progress: (value) => {
            if (value.stage === "import" && value.current > 0 && !interrupted) {
              interrupted = true
              throw new Error("interrupted")
            }
          },
        }),
      ).rejects.toThrow("interrupted")
      await StorageArtifactMigration.run({ dataRoot, store })
      await StorageArtifactMigration.run({ dataRoot, store })
      expect(await Bun.file(filename).exists()).toBe(false)
      await Storage.provide({ store, artifactDirectory: dataRoot }, async () =>
        expect(Buffer.from(await Storage.readBinary(key)).toString()).toBe("historical bytes"),
      )
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test.each([false, true])(
  "absent artifact sources are empty only without an interrupted migration: %s",
  async (interrupted) => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-empty-"))
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "empty",
      filename: path.join(root, "db"),
    })
    const key = ["storage_meta", "artifact-packs-v2"]
    const dataRoot = path.join(root, "absent")
    try {
      if (interrupted) await store.write(key, { version: 2, phase: "backup", cursor: 0 })
      if (interrupted) {
        await expect(StorageArtifactMigration.run({ dataRoot, store })).rejects.toMatchObject({ code: "ENOENT" })
        expect(await store.read(key)).toMatchObject({ phase: "backup" })
      } else {
        await StorageArtifactMigration.run({ dataRoot, store })
        await StorageArtifactMigration.run({ dataRoot, store })
        const completed = { version: 2, phase: "complete", cursor: 0 }
        expect(await store.read<typeof completed>(key)).toEqual(completed)
        expect(await Bun.file(dataRoot).exists()).toBe(false)
      }
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

afterRuntimeTests(() => runtime.close())

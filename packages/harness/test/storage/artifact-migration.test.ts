import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageArtifactMigration } from "../../src/storage/artifact-migration"
import { Storage } from "../../src/storage/storage"

test("existing SQL authority upgrades loose rollout bytes before runtime admission and can resume", async () => {
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
})

import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const keys = {
  async current() {
    return { version: "fixture", key: Buffer.alloc(32, 7) }
  },
  async resolve() {
    return Buffer.alloc(32, 7)
  },
}

test("native namespace evidence requires its actual current capture, Store and callback lifetime", async () => {
  await using temporary = await tmpdir()
  await using runtime = await testRuntime()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "foreign",
    filename: path.join(temporary.path, "foreign.sqlite"),
  })
  try {
    await runtime.run(async () => {
      await Storage.write(["canonical"], { original: true })
      let oldArchive:
        | Awaited<ReturnType<Parameters<Parameters<typeof SnapshotMaintenance.withCapture>[0]>[0]["exportArchive"]>>
        | undefined
      let escaped: Parameters<typeof SnapshotMaintenance.assertArchive>[0] | undefined
      await SnapshotMaintenance.withCapture(async (capture) => {
        const archive = await capture.exportArchive({
          directory: path.join(temporary.path, "first"),
          archiveID: "first",
          namespaceID: "original",
          buildVersion: "fixture",
          keys,
          protect: () => true,
        })
        oldArchive = archive
        const proof = await capture.validateArchive(archive)
        escaped = proof
        expect(SnapshotMaintenance.assertArchive(proof)).toEqual(archive)
        expect(() => SnapshotMaintenance.assertArchive({ ...proof })).toThrow("evidence")
        await Storage.provide({ ...Storage.current(), store: foreign }, async () => {
          expect(() => SnapshotMaintenance.assertArchive(proof)).toThrow("capture")
          await expect(capture.validateArchive(archive)).rejects.toThrow("capture")
        })
      })
      expect(() => SnapshotMaintenance.assertArchive(escaped!)).toThrow("capture")
      await SnapshotMaintenance.withCapture(async (capture) => {
        await expect(capture.validateArchive(oldArchive!)).rejects.toThrow("own exported")
      })
    })
  } finally {
    await foreign.close()
  }
})

test("archive evidence freshly verifies its original manifest against another valid namespace replacement", async () => {
  await using temporary = await tmpdir()
  await using runtime = await testRuntime()
  await runtime.run(() =>
    SnapshotMaintenance.withCapture(async (capture) => {
      const archive = await capture.exportArchive({
        directory: path.join(temporary.path, "original"),
        archiveID: "original",
        namespaceID: "original",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      const another = await capture.exportArchive({
        directory: path.join(temporary.path, "replacement"),
        archiveID: "replacement",
        namespaceID: "different",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      await fs.rename(archive.directory, archive.directory + "-retained")
      await fs.rename(another.directory, archive.directory)
      await expect(capture.validateArchive(archive)).rejects.toThrow("captured manifest")
    }),
  )
})

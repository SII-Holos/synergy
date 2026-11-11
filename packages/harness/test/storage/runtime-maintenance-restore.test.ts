import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

test("native restoration publishes a retained frozen maintenance cohort without reopening ordinary mutation or admission", async () => {
  const sourceRuntime = await storageTestRuntime()
  const targetRuntime = await storageTestRuntime()
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "maintenance-restore-"))
  const source = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
  )
  const target = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
  )
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "recovery-one", key }
    },
    async resolve() {
      return key
    },
  }
  const actor = {
    kind: "system" as const,
    subjectID: "operator",
    displayName: "Host operator",
    clientKind: "system" as const,
    requestID: "backup-one",
  }
  try {
    const lease = await sourceRuntime.run(() =>
      Storage.provide({ store: source, artifactDirectory: path.join(root, "source", "content") }, async () => {
        RuntimeMaintenance.configure({ required: ["writer"] })
        RuntimeMaintenance.register("writer", {
          version: 1,
          async suspend() {},
          async drain() {},
          async inspect() {
            return []
          },
          async release() {},
        })
        await Storage.write(["canonical", "future"], { nested: { preserved: true } })
        await Storage.writeBinary(["evidence", "one"], Buffer.from("immutable backup bytes"))
        const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        await StorageCheckpoint.exportArchive({
          directory: path.join(root, "archive"),
          archiveID: "maintenance-backup",
          namespaceID: "hosted-runtime",
          buildVersion: "fixture-build",
          keys,
          protect: (entry) => entry.type === "record",
        })
        return lease
      }),
    )
    await targetRuntime.run(() =>
      Storage.provide({ store: target, artifactDirectory: path.join(root, "target", "content") }, async () => {
        RuntimeMaintenance.registerProtection()
        await expect(
          StorageCheckpoint.restoreArchive({
            directory: path.join(root, "archive"),
            keys,
            restoreID: "restore-one",
            async finalize(tx) {
              await tx.write(["recovery", "gate"], { paused: true, uniqueWriter: false })
              throw new Error("Fixture finalization failed")
            },
          }),
        ).rejects.toThrow("Fixture finalization failed")
        expect(await RuntimeMaintenance.status()).toBeUndefined()
        expect(await Storage.query({ prefix: ["canonical"], limit: 1 })).toEqual([])
        await StorageCheckpoint.restoreArchive({
          directory: path.join(root, "archive"),
          keys,
          restoreID: "restore-one",
          async finalize(tx) {
            await tx.write(["recovery", "gate"], { paused: true, uniqueWriter: false })
          },
        })
        expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
        expect(await Storage.read(["canonical", "future"])).toEqual({ nested: { preserved: true } })
        expect(await Storage.readBinary(["evidence", "one"])).toEqual(Buffer.from("immutable backup bytes"))
        expect(await Storage.read(["recovery", "gate"])).toEqual({ paused: true, uniqueWriter: false })
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
        await expect(Storage.write(["canonical", "unsafe"], { changed: true })).rejects.toThrow()
        await expect(RuntimeMaintenance.release(lease)).rejects.toThrow()
        await expect(Storage.write(["runtime_maintenance", "current"], { maintenanceID: "forged" })).rejects.toThrow()
      }),
    )
  } finally {
    key.fill(0)
    await source.close()
    await target.close()
    await sourceRuntime.close()
    await targetRuntime.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

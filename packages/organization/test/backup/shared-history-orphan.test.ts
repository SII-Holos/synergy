import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationRecoveryWriters as Writers } from "../../src/backup/writers"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"

test("a genuine native shared artifact without any metadata cannot pass service-only recovery", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "shared-orphan-"))
  const context = RuntimeContext.create({
    home,
    root: path.join(home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
  })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(home, "state.sqlite"),
  })
  context.storage = { store, artifactDirectory: path.join(home, "artifacts") }
  try {
    await context.run(async () => {
      expect(await Writers.assertServiceOnly()).toEqual({ version: 1, externalWriters: 0 })
      const key = Keys.sharedBlobChunk("missing-upload", 1, "a".repeat(64), 0)
      await Storage.writeBinary(key, Uint8Array.from([0, 255, 17]))
      const inventory = await Storage.snapshot(async (tx) => {
        let artifacts = 0,
          records = 0
        for await (const entry of tx.exportEntries()) {
          if (entry.type === "artifact") {
            expect(entry.key).toEqual(key)
            artifacts++
          } else if (entry.type === "record" && entry.key[0] === "organization") records++
        }
        return { artifacts, records }
      })
      expect(inventory).toEqual({ artifacts: 1, records: 0 })
      await expect(Writers.assertServiceOnly()).rejects.toThrow("reconciliation")
    })
  } finally {
    await context.run(() => store.close())
    context.dispose()
    await fs.rm(home, { recursive: true, force: true })
  }
})

import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationResourceNative as Native } from "../../src/backup/resources"
import { resourceFixture } from "../support/resource-native"

const keys = {
  async current() {
    return { version: "resource-recovery", key: Buffer.alloc(32, 13) }
  },
  async resolve() {
    return Buffer.alloc(32, 13)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "resource-closure",
}

test("an authenticated resource segment with honest totals still refuses a missing earlier content object", async () => {
  await using f = await resourceFixture()
  const directory = path.join(f.root, "cohort")
  await Cohort.capture({
    service: Cohort.service(f.source.service.maintenance),
    resolve: async () => undefined,
    directory,
    archiveID: "resource-closure",
    buildVersion: "fixture",
    keys,
    actor,
  })
  const opened = path.join(f.root, "opened")
  await Archive.open({ directory, outputDirectory: opened, keys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.resources) throw new Error("Missing real resource segment")
  const source = path.join(base, "resources"),
    forged = path.join(f.root, "missing-old-object")
  const missing = createHash("sha256").update(f.versions[0]!).digest("hex")
  await f.source.service.maintenance.run(async () => {
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "resource-negative",
      filename: path.join(f.root, "forged.sqlite"),
    })
    try {
      const handle = { store, artifactDirectory: path.join(f.root, "forged-artifacts") }
      let omitted = 0,
        manifest: Native.Manifest | undefined
      for await (const entry of StorageCheckpoint.entries({
        directory: source,
        expected: inventory.resources!,
        keys,
      })) {
        if (entry.type === "record") {
          manifest = Native.Manifest.parse(entry.value)
          continue
        }
        if (entry.type !== "artifact") throw new Error("Unexpected original resource segment entry")
        if (entry.key[3] === missing) {
          omitted++
          continue
        }
        const pieces: Uint8Array[] = []
        for await (const piece of StorageCheckpoint.streamArtifact({ directory: source, location: entry.location }))
          pieces.push(piece)
        await Storage.provide(handle, () => Storage.writeBinary(entry.key, Buffer.concat(pieces)))
      }
      expect(omitted).toBe(1)
      if (!manifest) throw new Error("Missing original resource metadata")
      await Storage.provide(handle, () =>
        Storage.write(["resource-native", "manifest"], {
          ...manifest,
          objects: manifest.objects - 1,
          objectBytes: manifest.objectBytes - f.versions[0]!.byteLength,
        }),
      )
      const expected = await Storage.provide(handle, () =>
        StorageCheckpoint.exportArchive({
          directory: forged,
          archiveID: "resource-native",
          namespaceID: inventory.namespace.namespaceID,
          buildVersion: inventory.namespace.buildVersion,
          keys,
          protect: () => true,
        }),
      )
      await expect(
        Native.verify({
          directory: forged,
          expected,
          source: inventory.namespace,
          namespaceDirectory: path.join(base, "records"),
          keys,
        }),
      ).rejects.toThrow("missing a referenced resource object")
      expect(f.allocations).toBe(0)
    } finally {
      await store.close()
    }
  })
})

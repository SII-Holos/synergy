import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { runMigrations, upgradeImportedRecord } from "../../src/migration"
import { MaintenanceRetirementRecords as Records } from "../../src/storage/maintenance-retirement-records"
import { maintenanceRetirementPhysicalMigration } from "../../src/storage/maintenance-retirement-migration"

function record(maintenanceID: string) {
  return Records.Info.parse({
    version: 1,
    referenceHash: "a".repeat(64),
    source: {
      version: 1,
      maintenanceID,
      requestID: maintenanceID,
      requestHash: "b".repeat(64),
      purpose: "organization-backup",
      sourceRuntimeID: "original-native-runtime",
      cohortHash: "c".repeat(64),
      phase: "frozen",
      revision: 3,
      tailRevision: 0,
      actor: { kind: "system", subjectID: "host", displayName: "Host", clientKind: "system", requestID: maintenanceID },
      createdAt: 1,
      updatedAt: 2,
    },
  })
}

test("central retirement record validation rejects unknown versions and foreign source addresses", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const value = record("source")
    const key = Records.key("source")
    expect(upgradeImportedRecord(key, value)).toEqual(value)
    expect(() => upgradeImportedRecord(key, { ...value, version: 99 })).toThrow()
    expect(() => upgradeImportedRecord(Records.key("other"), value)).toThrow("canonical address")
    expect(() => upgradeImportedRecord(key, { ...value, source: { ...value.source, phase: "released" } })).toThrow()
    expect(() => upgradeImportedRecord([...key, "child"], value)).toThrow("canonical address")
  })
})

test("retirement physical validation reaches a corrupt row beyond its first page without deleting facts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    for (let index = 0; index < 65; index++) {
      const value = record(`source-${String(index).padStart(3, "0")}`)
      await Storage.current().store.write(Records.key(value.source.maintenanceID), value)
    }
    const key = Records.key("source-064")
    const original = record("source-064")
    const unknown = { ...original, version: 99 }
    await Storage.current().store.write(key, unknown)
    const logKey = StoragePath.metaMigrationLogDomain("storage")
    const log = await Storage.read<Record<string, number>>(logKey)
    const next = { ...log }
    delete next[maintenanceRetirementPhysicalMigration.id]
    await Storage.current().store.write(logKey, next)
    await expect(runMigrations({ targetDomain: "storage", output: "silent" })).rejects.toThrow()
    expect(await Storage.current().store.read(key)).toEqual(unknown)
    expect(
      (await Storage.read<Record<string, number>>(logKey))[maintenanceRetirementPhysicalMigration.id],
    ).toBeUndefined()
    await Storage.current().store.write(key, original)
    await runMigrations({ targetDomain: "storage", output: "silent" })
    expect((await Records.read("source-064"))?.referenceHash).toBe(original.referenceHash)
  })
}, 15_000)

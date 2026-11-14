import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { runMigrations, upgradeImportedRecord } from "../../src/migration"
import { EnvironmentPortableSchema as S } from "../../src/environment/portable-schema"
import { EnvironmentTransferRecords as Records } from "../../src/environment/transfer-records"
import {
  environmentTransferPhysicalMigration,
  environmentTransferHistoryMigration,
} from "../../src/environment/transfer-migration"

function source(handoffID = "selected-handoff") {
  return S.Source.parse({
    version: 1,
    kind: "source",
    scopeID: "home",
    sessionID: "selected-session",
    rootSessionID: "selected-session",
    handoffID,
    selected: {
      environmentID: "source-environment",
      provider: "native",
      generation: 0,
      state: "idle",
      descriptor: {
        version: 1,
        kind: "native",
        platform: "linux",
        architecture: "x64",
        capabilities: ["exec", "pty", "files"],
      },
    },
  })
}

async function rerunPhysicalMigration() {
  const key = StoragePath.metaMigrationLogDomain("environment")
  const log = await Storage.read<Record<string, number>>(key)
  const next = { ...log }
  delete next[environmentTransferPhysicalMigration.id]
  delete next[environmentTransferHistoryMigration.id]
  await Storage.write(key, next)
  return runMigrations({ targetDomain: "environment", output: "silent" })
}

test("Environment transfer facts retain exact immutable source and target identities", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const original = source()
    const receipt = S.Receipt.parse({
      version: 1,
      kind: "receipt",
      source: original,
      target: { ...original.selected, environmentID: "target-environment" },
    })
    await expect(Records.save(original)).rejects.toThrow("native transaction")
    await Storage.transaction(async () => {
      await Records.save(original)
      await Records.save(receipt)
      await Records.save(original)
      await Records.save(receipt)
    })
    const originalKey = Records.key(original)
    const receiptKey = Records.key(receipt)
    expect(await Records.source(original)).toEqual(original)
    expect(await Records.hasReceipts("home", original.sessionID)).toBeTrue()
    expect(await Records.hasReceipts("other-scope", original.sessionID)).toBeFalse()
    expect(await Storage.read(receiptKey)).toEqual(receipt)
    const changed = S.Source.parse({ ...original, selected: null })
    await expect(Storage.transaction(() => Records.save(changed))).rejects.toThrow("cannot change")
    await expect(Storage.transaction(() => Records.save({ ...receipt, target: null }))).rejects.toThrow()
    expect(await Storage.readMany([originalKey, receiptKey])).toEqual([original, receipt])
    original.rootSessionID = "changed-after-saving"
    receipt.source.selected = null
    expect(await Storage.read(originalKey)).toMatchObject({ rootSessionID: "selected-session" })
    expect(await Storage.read(receiptKey)).toMatchObject({
      source: { selected: { environmentID: "source-environment" } },
      target: { environmentID: "target-environment" },
    })
  })
})

test("the centrally registered Environment reader rejects foreign addresses and unknown transfer schemas", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const original = source()
    const key = Records.key(original)
    const otherScope = [...key]
    otherScope[2] = "another-scope"
    expect(upgradeImportedRecord(key, original)).toEqual(original)
    expect(() => upgradeImportedRecord(key, { ...original, version: 2 })).toThrow()
    expect(() => upgradeImportedRecord([...key, "unexpected-child"], original)).toThrow("canonical address")
    expect(() => upgradeImportedRecord(otherScope, original)).toThrow("canonical address")
    expect(() =>
      upgradeImportedRecord(key, { ...original, selected: { ...original.selected, spec: { token: "private" } } }),
    ).toThrow()
    expect(() => upgradeImportedRecord(key, { ...original, selected: undefined })).toThrow()
    const current = S.CurrentSource.parse({ ...original, version: 2, executions: 3 })
    expect(upgradeImportedRecord(key, current)).toEqual(current)
    expect(S.LegacySource.safeParse(current).success).toBe(false)
    expect(() => upgradeImportedRecord(key, { ...current, executions: undefined })).toThrow()
    expect(() => upgradeImportedRecord(key, { ...current, version: 3 })).toThrow()
  })
})

test("the central physical migration validates all retained transfer rows without dropping unknown facts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    for (let index = 0; index < 65; index++) {
      const original = source(`handoff-${String(index).padStart(3, "0")}`)
      await Storage.transaction(() => Records.save(original))
    }
    await rerunPhysicalMigration()
    const original = source("handoff-064")
    const key = Records.key(original)
    const unknown = { ...original, version: 99 }
    await Storage.write(key, unknown)
    await expect(rerunPhysicalMigration()).rejects.toThrow()
    expect(await Storage.current().store.read(key)).toEqual(unknown)
    expect(
      (await Storage.current().store.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("environment")))[
        environmentTransferPhysicalMigration.id
      ],
    ).toBeUndefined()
    await Storage.write(key, original)
    await rerunPhysicalMigration()
    expect(await Records.source(original)).toEqual(original)
    expect((await Storage.queryKeys({ prefix: Records.prefix, limit: 128 })).length).toBe(65)
  })
}, 15_000)

test("an explicit logical Environment mapping preserves immutable native source and legacy receipts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const legacy = source("legacy-native-mapping")
    const original = source("explicit-logical-mapping")
    const selected = original.selected
    if (!selected) throw new Error("The original native mapping fixture has no selected descriptor")
    const mapping = {
      version: 1,
      provider: "organization",
      hash: "a".repeat(64),
      source: {
        kind: "native",
        environmentID: selected.environmentID,
        provider: selected.provider,
        generation: selected.generation,
        descriptor: selected.descriptor,
      },
      target: {
        kind: "organization",
        resourceID: "selected-compute",
        resourceRevision: 2,
        environmentID: "cloud-environment",
      },
    }
    const current = S.Source.parse({ ...original, version: 3, executions: 0, mapping })
    const receipt = S.Receipt.parse({ version: 3, kind: "receipt", source: current, target: null })
    const legacyBytes = JSON.stringify(legacy)
    await Storage.transaction(async () => {
      await Records.save(legacy)
      await Records.save(current)
      await Records.save(receipt)
      await Records.save(current)
      await Records.save(receipt)
    })
    expect(await Records.source(current)).toEqual(current)
    expect(await Records.receipt(current)).toEqual(receipt)
    expect(JSON.stringify(await Storage.read(Records.key(legacy)))).toBe(legacyBytes)
    expect(current.selected).toEqual(selected)
    expect(receipt.target).toBeNull()
    expect(upgradeImportedRecord(Records.key(current), current)).toEqual(current)
    expect(upgradeImportedRecord(Records.key(receipt), receipt)).toEqual(receipt)
    expect(
      S.Receipt.safeParse({
        version: 2,
        kind: "receipt",
        source: { ...original, version: 2, executions: 0 },
        target: null,
      }).success,
    ).toBe(false)
    expect(S.Source.safeParse({ ...current, mapping: { ...mapping, hash: "unknown" } }).success).toBe(false)
    expect(S.Source.safeParse({ ...current, mapping: { ...mapping, allocationID: "caller-allocation" } }).success).toBe(
      false,
    )
    const changed = S.Source.parse({ ...current, mapping: { ...mapping, hash: "b".repeat(64) } })
    await expect(Storage.transaction(() => Records.save(changed))).rejects.toThrow("cannot change")
    expect(await Records.source(current)).toEqual(current)
  })
})

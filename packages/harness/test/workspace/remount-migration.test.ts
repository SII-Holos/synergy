import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { identifyDirectory } from "@ericsanchezok/synergy-util/filesystem-identity"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { workspaceMigrations } from "../../src/workspace/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { runMigrations } from "../../src/migration"
import { testRuntime } from "../support/runtime"

const migration = workspaceMigrations.find((item) => item.id === "20261018-remounted-volume-identity")!
const identify = (directory: string, missing?: boolean) => identifyDirectory(directory, missing, () => "fixture-volume")
const remount = (id: string) => {
  const [device, ...object] = id.split(":")
  return [BigInt(device) + 1n, ...object].join(":")
}

test("legacy remount upgrade is bounded to the catalog and preserves replaced, foreign and unverified history", async () => {
  await using runtime = await testRuntime()
  const source = runtime.host.workspaceLocation!
  const inspected: string[] = []
  source.identify = async (directory, missing) => {
    inspected.push(directory)
    return identify(directory, missing)
  }
  await runtime.run(async () => {
    const hostID = await source.hostID()
    const records: WorkspaceCatalog.Info[] = []
    for (const name of [
      "remounted",
      "exact",
      "replaced",
      "missing",
      "foreign",
      "unbound",
      "unknown",
      "alias",
      "stable",
      "file",
      "loop",
      "stable-changed",
    ]) {
      const directory = path.join(runtime.host.home, name)
      await fs.mkdir(directory)
      const actual = await identify(directory)
      const record = await WorkspaceCatalog.register({
        scopeID: "remount",
        type: "directory",
        hostID: name === "foreign" ? "foreign-host" : hostID,
        path: actual.path,
        physicalID:
          name === "stable-changed"
            ? actual.physicalID!.replace("fixture-volume", "another-volume")
            : name === "stable"
              ? actual.physicalID
              : name === "unknown"
                ? undefined
                : name === "exact"
                  ? actual.legacyPhysicalID
                  : remount(actual.legacyPhysicalID!),
      })
      if (name === "unbound") {
        record.binding.state = "unbound"
        await Storage.write(StoragePath.workspace(record.id), record)
      }
      records.push(record)
      if (["replaced", "file", "alias", "loop"].includes(name)) {
        await fs.rename(directory, directory + "-original")
        if (name === "replaced") await fs.mkdir(directory)
        if (name === "file") await Bun.write(directory, "not a directory")
        if (name === "alias")
          await fs.symlink(directory + "-original", directory, process.platform === "win32" ? "junction" : "dir")
        if (name === "loop" && process.platform !== "win32") await fs.symlink(directory, directory)
      }
      if (name === "missing") await fs.rm(directory, { recursive: true })
    }
    await Storage.write(StoragePath.workspace(records[0].id), {
      ...records[0],
      extension: { retained: true },
      binding: { ...records[0].binding, extension: 7 },
    })
    await Storage.transaction(async () => {
      for (let n = 0; n < 130; n++)
        await Storage.write(StoragePath.workspace(`stable-${n}`), { ...records[8], id: `stable-${n}` })
      for (let n = 0; n < 100; n++) await Storage.write(["session", "unrelated", `history-${n}`], { historical: true })
    })
    inspected.length = 0
    const readMany = Storage.readMany
    const batches: number[] = []
    const reads = spyOn(Storage, "readMany").mockImplementation(async (keys) => {
      expect(keys.some((key) => key[0] === "session" || key[0] === "message")).toBe(false)
      if (keys.length && keys.every((key) => key[0] === "workspace")) batches.push(keys.length)
      return readMany(keys)
    })
    try {
      await migration.up(() => {})
    } finally {
      reads.mockRestore()
    }
    expect(batches).toContain(128)
    expect(Math.max(...batches)).toBe(128)
    expect(inspected).toHaveLength(7)
    for (const record of records.slice(2)) expect(await WorkspaceCatalog.get(record.id, record.scopeID)).toEqual(record)
    for (const original of records.slice(0, 2)) {
      const current = await WorkspaceCatalog.get(original.id, original.scopeID)
      expect(current.binding.physicalID).toBe((await identify(original.binding.path!)).physicalID)
      expect(current.binding.generation).toBe(original.binding.generation)
      expect(current.revision).toBe(original.revision + 1)
      expect(await WorkspaceBinding.validate(current.id, current.scopeID)).toMatchObject({
        id: current.id,
        generation: original.binding.generation,
      })
      expect(
        await WorkspaceCatalog.register({
          scopeID: current.scopeID,
          type: current.type,
          hostID,
          path: current.binding.path!,
          physicalID: current.binding.physicalID,
        }),
      ).toEqual(current)
    }
    expect(await Storage.read(StoragePath.workspace(records[0].id))).toMatchObject({
      extension: { retained: true },
      binding: { extension: 7 },
    })
    const before = await Storage.readMany(records.map((record) => StoragePath.workspace(record.id)))
    await migration.up(() => {})
    expect(await Storage.readMany(records.map((record) => StoragePath.workspace(record.id)))).toEqual(before)
    await expect(WorkspaceBinding.validate(records[2].id, "remount")).rejects.toMatchObject({
      data: { reason: "identity_changed" },
    })
    await expect(WorkspaceBinding.validate(records.at(-1)!.id, "remount")).rejects.toMatchObject({
      data: { reason: "identity_changed" },
    })
  })
}, 30_000)

test("identity inspection failure leaves its binding unchanged and can be retried", async () => {
  await using runtime = await testRuntime()
  const source = runtime.host.workspaceLocation!
  await runtime.run(async () => {
    const directory = path.join(runtime.host.home, "retry")
    await fs.mkdir(directory)
    const actual = await identify(directory)
    const original = await WorkspaceCatalog.register({
      scopeID: "retry",
      type: "directory",
      hostID: await source.hostID(),
      path: actual.path,
      physicalID: remount(actual.legacyPhysicalID!),
    })
    source.identify = async () => {
      throw Object.assign(new Error("inspection failed"), { code: "EIO" })
    }
    await expect(migration.up(() => {})).rejects.toThrow("inspection failed")
    expect(await WorkspaceCatalog.get(original.id, original.scopeID)).toEqual(original)
    source.identify = identify
    await migration.up(() => {})
    expect((await WorkspaceCatalog.get(original.id, original.scopeID)).binding.physicalID).toBe(actual.physicalID)
  })
})

test("installed remount startup does not enumerate unrelated storage roots", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const key = StoragePath.metaMigrationLogDomain("workspace")
    const ledger = await Storage.read<Record<string, number>>(key)
    delete ledger[migration.id]
    await Storage.write(key, ledger)
    await Storage.write(["sessions", "historical", "cold", "info"], { retained: true })
    using scan = spyOn(StoreTransaction.prototype, "scan")
    expect((await runMigrations({ output: "silent" })).completed).toBe(1)
    expect(scan.mock.calls.filter(([prefix]) => !prefix.length || prefix[0] === "sessions")).toEqual([])
    expect(await Storage.read<{ retained: boolean }>(["sessions", "historical", "cold", "info"])).toEqual({
      retained: true,
    })
  })
})

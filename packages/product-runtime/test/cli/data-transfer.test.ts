import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DataTransfer } from "../../src/cli/data/transfer"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("merge keeps the target session aggregate and retains skipped source evidence", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const id = Identifier.descending("session")
  const addedID = Identifier.descending("session")
  const sourceRoot = path.join(tmp.path, "source")
  const targetRoot = path.join(tmp.path, "target")
  for (const [root, title] of [
    [sourceRoot, "source"],
    [targetRoot, "target"],
  ]) {
    const prepared = await StorageBootstrap.prepare({ root })
    try {
      await Storage.provide({ store: prepared.store, artifactDirectory: path.join(root, "data") }, () =>
        ScopeContext.provide({
          scope,
          fn: async () => {
            await Storage.write(["projects", scope.id], scope)
            await Session.create({ id, title })
            await Storage.write(["sessions", scope.id, id, "owner-extension"], { title })
            if (root === sourceRoot) {
              await Session.create({ id: addedID, title: "new session" })
              await Storage.write(["sessions", scope.id, id, "source-only"], { preserve: true })
              await Bun.write(path.join(root, "data", "sessions", scope.id, id, "private.bin"), "source evidence")
            }
          },
        }),
      )
      await prepared.activate()
    } finally {
      await prepared.store.close()
    }
  }
  await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
  const result = await DataTransfer.merge(sourceRoot, targetRoot)
  expect(result.skippedSessions).toBe(1)
  const target = await StorageBootstrap.inspect(targetRoot)
  if (!target) throw new Error("missing target")
  try {
    expect(await target.store.read<{ title: string }>(["sessions", scope.id, id, "owner-extension"])).toEqual({
      title: "target",
    })
    expect((await target.store.readMany([["sessions", scope.id, id, "source-only"]]))[0]).toBeUndefined()
    expect(await Bun.file(path.join(targetRoot, "data", "sessions", scope.id, id, "private.bin")).exists()).toBe(false)
    expect(await target.store.read(["session_index", addedID])).toMatchObject({ scopeID: scope.id })
    const [transfer] = await target.store.query<{ backup: string }>({ kind: "storage_transfer" })
    expect(
      await Bun.file(
        path.join(targetRoot, transfer.value.backup, "data", "sessions", scope.id, id, "private.bin"),
      ).text(),
    ).toBe("source evidence")
    expect((await target.store.verify()).issues).toEqual([])
  } finally {
    await target.store.close()
  }
})

test("portable pack restores authority without copying the source database identity", async () => {
  await using tmp = await tmpdir()
  const sourceRoot = path.join(tmp.path, "source")
  const restoredRoot = path.join(tmp.path, "restored")
  const source = await StorageBootstrap.prepare({ root: sourceRoot })
  await source.store.write(["future-owner", "record"], { nested: { unknown: 42 } })
  await source.activate()
  await source.store.close()
  await DataTransfer.pack(sourceRoot, path.join(restoredRoot, "data"))
  expect(await Bun.file(path.join(restoredRoot, "data", "storage", "manifest.json")).exists()).toBe(false)
  const restored = await StorageBootstrap.prepare({ root: restoredRoot })
  try {
    expect(await restored.store.read<{ nested: { unknown: number } }>(["future-owner", "record"])).toEqual({
      nested: { unknown: 42 },
    })
    expect(restored.manifest.storeID).not.toBe(source.manifest.storeID)
    await restored.activate()
    await fs.rm(sourceRoot, { recursive: true })
    expect(await restored.store.read<{ nested: { unknown: number } }>(["future-owner", "record"])).toEqual({
      nested: { unknown: 42 },
    })
  } finally {
    await restored.store.close()
  }
})

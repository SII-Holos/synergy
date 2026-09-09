import { describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { $ } from "bun"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotTransfer } from "../../src/session/snapshot-transfer"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"

for (const phase of ["imported", "verified", "protected", "switched"] as const) {
  test(`migration resumes after durable ${phase} checkpoint`, async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await Bun.write(path.join(tmp.path, "history.txt"), "survives interruption")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await SnapshotMaintenance.registerLegacy()
        const write = SnapshotStore.write
        {
          let interrupted = false
          using fault = spyOn(SnapshotStore, "write").mockImplementation(async (key, value) => {
            await write(key, value)
            if (!interrupted && key.includes("migrations") && (value as { phase?: string }).phase === phase) {
              interrupted = true
              throw new Error("simulated interruption after checkpoint")
            }
          })
          expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("failed")
        }
        expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(true)
        expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("migrated")
        expect(await SnapshotStore.owns(scope.id, session.id, tree)).toBe(true)
        expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(false)
        expect(
          (await fs.readdir(path.join(SnapshotStore.repository(scope.id), "objects", "pack"))).filter((name) =>
            name.endsWith(".keep"),
          ),
        ).toEqual([])
      },
    })
  })
}

test("migration materializes alternates once and preserves unknown blobs", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const pool = path.join(tmp.path, "old-pool")
      await SnapshotStore.initializeBareRepository(pool)
      await Bun.write(path.join(tmp.path, "file.txt"), "baseline")
      await SnapshotStore.command(pool, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
      const tree = await SnapshotStore.command(pool, ["write-tree"])
      await Bun.write(path.join(tmp.path, "orphan.txt"), "orphan")
      const unknown = await SnapshotStore.command(pool, ["hash-object", "-w", path.join(tmp.path, "orphan.txt")])
      const sessions = [await Session.create({ scope }), await Session.create({ scope })]
      for (const session of sessions) {
        const repo = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(repo)
        await Bun.write(path.join(repo, "objects", "info", "alternates"), path.join(pool, "objects") + "\n")
      }
      await SnapshotMaintenance.registerLegacy()
      const result = await SnapshotMaintenance.migrate(scope.id, { apply: true })
      expect(result.results.every((entry) => entry.status === "migrated")).toBe(true)
      expect(result.results.filter((entry) => entry.objectsAdded === 0)).toHaveLength(1)
      await fs.rm(pool, { recursive: true })
      for (const session of sessions) expect(await SnapshotStore.owns(scope.id, session.id, tree)).toBe(true)
      expect(
        await SnapshotStore.command(SnapshotStore.repository(scope.id), [
          "rev-parse",
          `refs/synergy/preserved/${unknown}`,
        ]),
      ).toBe(unknown)
      expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(true)
    },
  })
})

describe("snapshot maintenance", () => {
  test("non-pruning compaction recovers interrupted import packs conservatively", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const source = path.join(tmp.path, "interrupted")
    await SnapshotStore.initializeBareRepository(source)
    await Bun.write(path.join(tmp.path, "old.txt"), "unknown history")
    await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "old.txt"])
    const tree = await SnapshotStore.command(source, ["write-tree"])
    await SnapshotStore.initializeRepository(scope.id)
    const target = SnapshotStore.repository(scope.id)
    {
      await using catalog = await SnapshotTransfer.Catalog.create(target)
      await catalog.import(source)
    }
    await fs.rm(source, { recursive: true })
    await expect(SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })).rejects.toThrow(
      "import protection",
    )
    const recovered = await SnapshotMaintenance.compact(scope.id, { apply: true })
    expect(recovered.recoveredObjects).toBeGreaterThan(0)
    await SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })
    expect(await SnapshotStore.command(target, ["show", `${tree}:old.txt`])).toBe("unknown history")
  })
  test("migration refuses a shared target that depends on alternates", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const legacy = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(legacy)
        await SnapshotMaintenance.registerLegacy()
        await SnapshotStore.initializeRepository(scope.id)
        await Bun.write(
          path.join(SnapshotStore.repository(scope.id), "objects", "info", "alternates"),
          path.join(legacy, "objects") + "\n",
        )
        await expect(SnapshotMaintenance.migrate(scope.id, { apply: true })).rejects.toThrow("external object")
        expect(await Bun.file(path.join(legacy, "HEAD")).exists()).toBe(true)
      },
    })
  })
  test("migration retains unreferenced legacy trees and is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const repo = SnapshotStore.legacyRepository(scope.id, session.id)
        await fs.mkdir(repo, { recursive: true })
        await $`git init --bare ${repo}`.quiet()
        const file = path.join(tmp.path, "old.txt")
        await Bun.write(file, "old history")
        await SnapshotStore.command(repo, ["-C", tmp.path, "--work-tree", tmp.path, "add", "--all"])
        const tree = await SnapshotStore.command(repo, ["write-tree"])
        await SnapshotMaintenance.registerLegacy()
        expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("legacy")
        const dry = await SnapshotMaintenance.migrate(scope.id)
        expect(dry.results.find((entry) => entry.sessionID === session.id)?.status).toBe("pending")
        expect(await Bun.file(path.join(repo, "HEAD")).exists()).toBe(true)
        const applied = await SnapshotMaintenance.migrate(scope.id, { apply: true })
        expect(applied.results.find((entry) => entry.sessionID === session.id)?.status).toBe("migrated")
        expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("shared")
        expect(await Bun.file(path.join(repo, "HEAD")).exists()).toBe(false)
        expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(true)
        await SnapshotMaintenance.migrate(scope.id, { apply: true })
        await Bun.write(file, "later")
        await Snapshot.revert([{ hash: tree, files: [file] }], session.id)
        expect(await Bun.file(file).text()).toBe("old history")
      },
    })
  })

  test("pruning refuses a missing history root instead of deleting other objects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        await Bun.write(path.join(tmp.path, "a.txt"), "retained")
        await Snapshot.track(session.id)
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID("message-test"),
            Identifier.asPartID("part-test"),
          ),
          { type: "step-start", snapshot: "a".repeat(40) },
        )
        expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(false)
        await expect(SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })).rejects.toThrow()
      },
    })
  })
})

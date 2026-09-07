import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Global } from "../../src/global"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

async function makeLegacyRepo(scopeID: string, sessionID: string) {
  const repo = SnapshotStore.legacyRepository(scopeID, sessionID)
  await SnapshotStore.initializeBareRepository(repo)
  return repo
}

describe("snapshot clean", () => {
  test("dry run lists unowned candidates and deletes nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const unowned = "ses_cleanUnowned01"
        const owned = "ses_cleanOwned001"
        await makeLegacyRepo(scope.id, unowned)
        await makeLegacyRepo(scope.id, owned)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, owned), { version: 2, backend: "legacy" })

        const dry = await SnapshotMaintenance.clean(scope.id)
        expect(dry.applied).toBe(false)
        expect(dry.candidates.map((entry) => entry.sessionID)).toEqual([unowned])
        expect(dry.candidates[0]!.reason).toBe("unowned")
        expect(dry.skippedProtected).toBe(1)
        expect(dry.removed).toBe(0)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, unowned), "HEAD")).exists()).toBe(true)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, owned), "HEAD")).exists()).toBe(true)
      },
    })
  })

  test("__reclaimed__ legacy directories are reclaimed and removable", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const reclaimed = "ses_cleanReclaim01"
        await makeLegacyRepo("__reclaimed__", reclaimed)

        const dry = await SnapshotMaintenance.clean("__reclaimed__")
        expect(dry.candidates.map((entry) => entry.sessionID)).toEqual([reclaimed])
        expect(dry.candidates[0]!.reason).toBe("reclaimed")

        const applied = await SnapshotMaintenance.clean("__reclaimed__", { apply: true })
        expect(applied.applied).toBe(true)
        expect(applied.removed).toBe(1)
        await expect(fs.access(SnapshotStore.legacyRepository("__reclaimed__", reclaimed))).rejects.toThrow()
      },
    })
  })

  test("__reclaimed__ legacy directories with session records are never candidates", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await fs.rm(path.join(Global.Path.snapshot, "__reclaimed__"), { recursive: true, force: true })
        await Storage.removeTree(["sessions", Identifier.asScopeID("__reclaimed__")])
        const kept = "ses_cleanKeptRc01"
        const recordless = "ses_cleanRcOrph01"
        await makeLegacyRepo("__reclaimed__", kept)
        await makeLegacyRepo("__reclaimed__", recordless)
        await Storage.write(
          StoragePath.sessionInfo(Identifier.asScopeID("__reclaimed__"), Identifier.asSessionID(kept)),
          {
            id: kept,
            scope: { directory: "/tmp/snapshot-clean-fixture" },
            title: "kept reclaimed session",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        )

        const dry = await SnapshotMaintenance.clean("__reclaimed__")
        expect(dry.applied).toBe(false)
        expect(dry.candidates.map((entry) => entry.sessionID)).toEqual([recordless])
        expect(dry.candidates[0]!.reason).toBe("reclaimed")
        expect(dry.skippedProtected).toBe(1)

        const applied = await SnapshotMaintenance.clean("__reclaimed__", { apply: true })
        expect(applied.removed).toBe(1)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository("__reclaimed__", kept), "HEAD")).exists()).toBe(
          true,
        )
        await expect(fs.access(SnapshotStore.legacyRepository("__reclaimed__", recordless))).rejects.toThrow()
      },
    })
  })

  test("apply removes unowned directories and protects owner and session records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const unowned = "ses_cleanUnowned02"
        const owned = "ses_cleanOwned002"
        const hasSession = "ses_cleanSession2"
        await makeLegacyRepo(scope.id, unowned)
        await makeLegacyRepo(scope.id, owned)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, owned), { version: 2, backend: "legacy" })
        await makeLegacyRepo(scope.id, hasSession)
        await Storage.write(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(hasSession)),
          {
            id: hasSession,
            scope: { directory: "/tmp/snapshot-clean-fixture" },
            title: "kept",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        )

        const applied = await SnapshotMaintenance.clean(scope.id, { apply: true })
        expect(applied.applied).toBe(true)
        expect(applied.candidates.map((entry) => entry.sessionID)).toEqual([unowned])
        expect(applied.removed).toBe(1)
        expect(applied.skippedProtected).toBe(2)
        await expect(fs.access(SnapshotStore.legacyRepository(scope.id, unowned))).rejects.toThrow()
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, owned), "HEAD")).exists()).toBe(true)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, hasSession), "HEAD")).exists()).toBe(
          true,
        )
      },
    })
  })

  test("apply refuses a scope that fails the integrity check instead of deleting", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(tmp.path, "a.txt"), "retained")
        await Snapshot.track(session.id)
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID("message-clean"),
            Identifier.asPartID("part-clean"),
          ),
          { type: "step-start", snapshot: "a".repeat(40) },
        )
        const orphan = "ses_cleanUnowned03"
        await makeLegacyRepo(scope.id, orphan)

        expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(false)
        await expect(SnapshotMaintenance.clean(scope.id, { apply: true })).rejects.toThrow("integrity check failed")
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, orphan), "HEAD")).exists()).toBe(true)
      },
    })
  })
})

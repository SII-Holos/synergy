import { expect, test } from "bun:test"
import path from "node:path"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotLifecycle } from "../../src/session/snapshot-lifecycle"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { StoragePath } from "../../src/storage/path"

test("interrupted permanent deletion retains roots until canonical removal and resumes", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const source = await Session.create({ scope })
      await Bun.write(path.join(tmp.path, "a.txt"), "retained")
      const hash = (await Snapshot.track(source.id))!
      await SnapshotLifecycle.beginDelete(scope.id, source.id)
      await expect(SnapshotLifecycle.completeDelete(scope.id, source.id)).rejects.toThrow("before permanent")
      expect(
        await SnapshotStore.command(SnapshotStore.repository(scope.id), [
          "rev-parse",
          SnapshotStore.reference(source.id, hash),
        ]),
      ).toBe(hash)
      await SnapshotLifecycle.recover(scope.id)
      expect(await SnapshotStore.optional(StoragePath.snapshotDeletion(scope.id, source.id))).toBeUndefined()
      expect(
        await SnapshotStore.optional(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(source.id)),
        ),
      ).toBeUndefined()
      expect(await SnapshotStore.owns(scope.id, source.id, hash)).toBe(false)
      await SnapshotLifecycle.recover(scope.id)
    },
  })
})

test("JSON import retains available snapshots and reports missing objects", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const source = await Session.create({ scope })
      await Bun.write(path.join(tmp.path, "a.txt"), "available")
      const hash = (await Snapshot.track(source.id))!
      const message = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: source.id,
        role: "user",
        time: { created: Date.now() },
        agent: "synergy",
        model: { providerID: "test", modelID: "test" },
      })
      for (const snapshot of [hash, "a".repeat(40)]) {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: source.id,
          type: "snapshot",
          snapshot,
        })
      }
      const report = await SessionExport.generate({ sessionID: source.id, mode: "full" })
      const imported = await SessionImport.fromReport(report)
      expect(await SnapshotStore.owns(scope.id, imported.rootSessionID, hash)).toBe(true)
      expect(imported.warnings.some((warning) => warning.includes("1 unavailable file snapshots"))).toBe(true)
      await Session.remove(source.id)
      expect(await SnapshotStore.owns(scope.id, imported.rootSessionID, hash)).toBe(true)
    },
  })
})

for (const backend of ["shared", "legacy"] as const) {
  test(`forked ${backend} snapshot survives permanent deletion of its original owner and GC`, async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = await Session.create({ scope })
        if (backend === "legacy") {
          await SnapshotStore.initializeBareRepository(SnapshotStore.legacyRepository(scope.id, source.id))
          await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, source.id), { version: 2, backend })
        }
        const file = path.join(tmp.path, "history.txt")
        await Bun.write(file, "original")
        const hash = (await Snapshot.track(source.id))!
        const message = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: source.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: source.id,
          type: "snapshot",
          snapshot: hash,
        })
        const fork = await Session.fork({ sessionID: source.id })
        expect(await SnapshotStore.owns(scope.id, fork.id, hash)).toBe(true)
        await Session.remove(source.id)
        await SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })
        expect(await SnapshotStore.owns(scope.id, source.id, hash)).toBe(false)
        await Bun.write(file, "changed")
        await Snapshot.revert([{ hash, files: [file] }], fork.id)
        expect(await Bun.file(file).text()).toBe("original")
      },
    })
  })
}

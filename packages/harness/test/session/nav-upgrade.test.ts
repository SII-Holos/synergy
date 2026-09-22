import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionNav, type ScopeNavIndex } from "../../src/session/nav"
import { SessionRecords } from "../../src/session/records"
import { migrations } from "../../src/session/migration"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { runMigrations } from "../../src/migration"

const bindingMigration = "20260921-session-workspace-binding"
const repairMigration = "20260922-session-nav-workspace-binding"

function ownerReceipt(info: Session.Info) {
  return ["sessions", info.scope.id, info.id, "migrations", "session", bindingMigration]
}

function infoKey(info: Session.Info) {
  return StoragePath.sessionInfo(Identifier.asScopeID(info.scope.id), Identifier.asSessionID(info.id))
}

async function historical(info: Session.Info, home: string) {
  const { local, ...scope } = info.scope
  const before = {
    ...info,
    scope: { ...scope, ...(local ?? { directory: home, worktree: home, sandboxes: [] }) },
    workspace: info.workspace ?? { type: "main", path: home, scopeID: "home" },
    time: { ...info.time, created: 100, updated: 200 },
    retainedMetadata: { owner: "unloaded-extension" },
  }
  await Storage.write(infoKey(info), before)
  await Storage.remove(ownerReceipt(info))
  return before
}

test("nav rebuild upgrades historical Session bindings before validating entries", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Historical parent", tags: ["release"] })
        const child = await Session.create({ title: "Historical child", parentID: parent.id })
        const archived = await Session.create({ title: "Historical archived" })
        await Session.update(archived.id, (draft) => {
          draft.time.archived = 300
        })
        const infos = [parent, child, await Session.get(archived.id)]
        const before = await Promise.all(infos.map((info) => historical(info, runtime.host.home)))
        const evidenceKey = ["sessions", scope.id, parent.id, "messages", "msg_unread", "info"]
        const evidence = { preservedEvidence: "Index repair must not hydrate or rewrite history" }
        await Storage.write(evidenceKey, evidence)
        const index = await SessionNav.buildNavIndex(scope.id)
        expect(index.entries.map((entry) => entry.id).sort()).toEqual(infos.map((info) => info.id).sort())
        expect(index.entries.find((entry) => entry.id === parent.id)).toMatchObject({
          tags: ["release"],
          lastActivityAt: 200,
        })
        expect(index.entries.find((entry) => entry.id === child.id)).toMatchObject({
          parentID: parent.id,
          category: "background",
        })
        expect(index.entries.find((entry) => entry.id === archived.id)).toMatchObject({
          archived: true,
          archivedAt: 300,
        })
        for (const [i, info] of infos.entries()) {
          expect(await Storage.read<Record<string, unknown>>(infoKey(info))).toEqual({
            ...before[i],
            scope: info.scope,
            workspace: info.workspace,
          })
          expect(await Storage.read(ownerReceipt(info))).toHaveProperty("completed")
        }
        expect(await Storage.read<typeof evidence>(evidenceKey)).toEqual(evidence)
      },
    })
  })
})

test("Runtime startup repairs empty indexes after the original nav migration was recorded complete", async () => {
  await using tmp = await tmpdir({ git: true })
  const first = await testRuntime({ home: tmp.path })
  const seeded = await first.run(async () => {
    const scope = await tmp.scope()
    const project = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "Project history" }) })
    const home = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Session.create({ title: "Home history" }),
    })
    const accessed = await ScopeContext.provide({
      scope,
      fn: () => Session.create({ title: "Already accessed history" }),
    })
    const infos = [project, home, accessed]
    const before = await Promise.all(infos.map((info) => historical(info, first.host.home)))
    await SessionRecords.read(infoKey(accessed))
    const accessedReceipt = await Storage.read<{ completed: number }>(ownerReceipt(accessed))
    for (const info of infos) {
      await Storage.write(StoragePath.sessionNavIndex(Identifier.asScopeID(info.scope.id)), {
        version: 1,
        scopeID: info.scope.id,
        updatedAt: 300,
        entries: [],
      } satisfies ScopeNavIndex)
    }
    const tracking = StoragePath.metaMigrationLogDomain("session")
    await Storage.update<Record<string, number>>(tracking, (log) => {
      log["20260921-session-nav-tags"] = 1
      log[bindingMigration] = 1
      delete log[repairMigration]
    })
    return { infos, before, accessedReceipt }
  })
  await first.close()

  await using reopened = await testRuntime({ home: tmp.path })
  await reopened.run(async () => {
    for (const [index, info] of seeded.infos.entries()) {
      const nav = await SessionNav.readNavIndex(info.scope.id)
      expect(nav.entries.map((entry) => entry.id)).toContain(info.id)
      expect(nav.entries.find((entry) => entry.id === info.id)).toMatchObject({ lastActivityAt: 200 })
      expect(await Storage.read<Record<string, unknown>>(infoKey(info))).toEqual({
        ...seeded.before[index],
        scope: info.scope,
        workspace: info.workspace,
      })
    }
    const tracking = await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("session"))
    expect(tracking[repairMigration]).toBeNumber()
    expect(await Storage.read<{ completed: number }>(ownerReceipt(seeded.infos[2]!))).toEqual(seeded.accessedReceipt)
    expect((await runMigrations({ targetDomain: "session", output: "silent" })).completed).toBe(0)
  })
})

test("owner-local nav repair upgrades only its deferred Session and preserves unrelated historical records", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const infos = await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => [
        await Session.create({ title: "Admitted owner" }),
        await Session.create({ title: "Unrelated history" }),
      ],
    })
    const before = await Promise.all(infos.map((info) => historical(info, runtime.host.home)))
    const navKey = StoragePath.sessionNavIndex(Identifier.asScopeID("home"))
    await Storage.write(navKey, { version: 1, scopeID: "home", updatedAt: 300, entries: [] } satisfies ScopeNavIndex)
    const migration = migrations.find((entry) => entry.id === repairMigration)
    expect(migration?.upSession).toBeDefined()
    const owner = { scopeID: "home", sessionID: infos[0]!.id }
    await Storage.withMigrationRecords(() => Storage.transaction(() => migration!.upSession!(owner, () => {})))
    expect((await SessionNav.readNavIndex("home")).entries.map((entry) => entry.id)).toEqual([owner.sessionID])
    expect(await Storage.read<Record<string, unknown>>(infoKey(infos[0]!))).toEqual({
      ...before[0],
      scope: infos[0]!.scope,
      workspace: null,
    })
    expect(await Storage.read<Record<string, unknown>>(infoKey(infos[1]!))).toEqual(before[1])
    expect(await Storage.readMany([ownerReceipt(infos[1]!)])).toEqual([undefined])
  })
})

test("nav binding upgrades and their receipts roll back with the index transaction", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const session = await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ title: "Rollback" }) })
    const before = await historical(session, runtime.host.home)
    const key = StoragePath.sessionNavIndex(Identifier.asScopeID("home"))
    const originalIndex = await Storage.read<ScopeNavIndex>(key)
    await expect(
      Storage.transaction(async () => {
        const index = await SessionNav.buildNavIndex("home")
        expect(index.entries.map((entry) => entry.id)).toContain(session.id)
        throw new Error("Interrupted index publication")
      }),
    ).rejects.toThrow("Interrupted index publication")
    expect(await Storage.read<Record<string, unknown>>(infoKey(session))).toEqual(before)
    expect(await Storage.readMany([ownerReceipt(session)])).toEqual([undefined])
    expect(await Storage.read<ScopeNavIndex>(key)).toEqual(originalIndex)
    expect((await SessionNav.buildNavIndex("home")).entries.map((entry) => entry.id)).toContain(session.id)
  })
})

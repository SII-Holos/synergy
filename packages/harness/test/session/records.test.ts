import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionRecords } from "../../src/session/records"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("lists more Workspace-backed sessions than storage admission capacity", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const seed = await Session.create({ workspace: null })
        const workspace = await WorkspaceCatalog.register({
          scopeID: scope.id,
          type: "main",
          hostID: "test",
          path: files.path,
        })
        const records = Array.from({ length: 1300 }, (_, index) => ({
          ...SessionRecords.serialize(seed),
          id: Identifier.ascending("session"),
          title: `Fixture Session ${index}`,
          workspaceID: index < 150 ? workspace.id : `wsp_fixture_${index}`,
        }))
        await Storage.transaction(async (tx) => {
          for (const [index, record] of records.entries()) {
            if (index >= 150)
              await Storage.write(["workspace", record.workspaceID], { ...workspace, id: record.workspaceID })
            await Storage.write(["sessions", scope.id, record.id, "info"], record)
          }
          await Session.rebuildStorageIndexes(tx)
        })
        const listed = []
        for await (const session of Session.listAll()) listed.push(session)
        expect(listed).toHaveLength(records.length + 1)
        const byID = new Map(listed.map((session) => [session.id, session]))
        for (const record of records) {
          expect(byID.get(record.id)).toMatchObject({
            title: record.title,
            workspace: { id: record.workspaceID, path: files.path },
          })
        }
        const page = await Session.list()
        expect(page.data).toHaveLength(records.length + 1)
        const search = await Session.list({ search: "Fixture Session" })
        expect(search.data).toHaveLength(records.length)
        await Storage.transaction(async (tx) => {
          for (const record of records)
            await Storage.write(["sessions", scope.id, record.id, "info"], { ...record, parentID: seed.id })
          await Session.rebuildStorageIndexes(tx)
        })
        expect(await Session.children(seed.id)).toHaveLength(records.length)
        expect((await Session.childPage({ parentID: seed.id })).items).toHaveLength(records.length)
        const keys = records.slice(0, 2).map((record) => ["sessions", scope.id, record.id, "info"])
        await WorkspaceCatalog.rebind(workspace.id, {
          scopeID: scope.id,
          expectedRevision: workspace.revision,
          hostID: "test",
          path: `${files.path}/moved`,
        })
        expect((await SessionRecords.readMany(keys)).map((session) => session?.workspace?.path)).toEqual([
          `${files.path}/moved`,
          `${files.path}/moved`,
        ])
      },
    })
  })
}, 30_000)

test("batch hydration preserves missing, foreign, null and legacy Workspace semantics", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const seed = await Session.create({ workspace: null })
        const foreign = await WorkspaceCatalog.register({
          scopeID: "foreign",
          type: "main",
          hostID: "test",
          path: "/foreign",
        })
        const legacy = { ...seed, id: Identifier.ascending("session"), workspaceID: undefined }
        const records = [
          { ...SessionRecords.serialize(seed), id: Identifier.ascending("session"), workspaceID: "wsp_missing" },
          { ...SessionRecords.serialize(seed), id: Identifier.ascending("session"), workspaceID: foreign.id },
          { ...SessionRecords.serialize(seed), id: Identifier.ascending("session"), workspaceID: null },
          legacy,
        ]
        const keys = records.map((record) => ["sessions", scope.id, record.id, "info"])
        await Storage.transaction(async () => {
          for (const [index, record] of records.entries()) await Storage.write(keys[index]!, record)
        })
        const result = await SessionRecords.readMany([...keys, ["sessions", scope.id, "ses_missing", "info"], keys[0]!])
        expect(result[0]).toMatchObject({ workspace: null, workspaceError: "Workspace metadata is unavailable" })
        expect(result[1]).toMatchObject({ workspace: null, workspaceError: "Workspace metadata is unavailable" })
        expect(result[2]).toMatchObject({ workspace: null, workspaceID: null })
        expect(result[3]).toMatchObject({ workspace: null, workspaceID: null })
        expect(await SessionRecords.hydrate(legacy)).toEqual(legacy)
        expect(result[4]).toBeUndefined()
        expect(result[5]).toEqual(result[0])
        await Storage.write(["workspace", "wsp_missing"], { invalid: true })
        await expect(SessionRecords.readMany([keys[0]!])).rejects.toThrow()
      },
    })
  })
})

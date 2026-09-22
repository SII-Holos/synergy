import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Server } from "../../src/server/server"

test("normal startup restores historical navigation and global search after an empty index was committed", async () => {
  await using tmp = await tmpdir()
  const options = { home: tmp.path, composition: { register: registerLocalRuntime } }
  const original = await testRuntime(options)
  let sessionID: string
  try {
    sessionID = await original.run(async () => {
      const session = await ScopeContext.provide({
        scope: Scope.home(),
        fn: () => Session.create({ title: "Existing Home conversation", tags: ["history"] }),
      })
      await Storage.write(StoragePath.sessionInfo(Identifier.asScopeID("home"), Identifier.asSessionID(session.id)), {
        ...session,
        scope: { type: "home", id: "home", directory: tmp.path, worktree: tmp.path, sandboxes: [] },
        workspace: { type: "main", path: tmp.path, scopeID: "home" },
        time: { created: 100, updated: 200 },
      })
      await Storage.remove([
        "sessions",
        "home",
        session.id,
        "migrations",
        "session",
        "20260921-session-workspace-binding",
      ])
      await Storage.write(StoragePath.sessionNavIndex(Identifier.asScopeID("home")), {
        version: 1,
        scopeID: "home",
        updatedAt: 300,
        entries: [],
      })
      await Storage.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("session"), (tracking) => {
        tracking["20260921-session-nav-tags"] = 1
        delete tracking["20260922-session-nav-workspace-binding"]
      })
      const response = await Server.App().request("/global/session")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ total: 0, data: [] })
      return session.id
    })
  } finally {
    await original.close()
  }

  await using reopened = await testRuntime(options)
  await reopened.run(async () => {
    const app = Server.App()
    const nav = await app.request("/session/index?scopeID=home&category=home")
    expect(nav.status).toBe(200)
    expect(await nav.json()).toMatchObject({
      total: 1,
      items: [{ id: sessionID, title: "Existing Home conversation", tags: ["history"], lastActivityAt: 200 }],
    })
    const search = await app.request("/global/session")
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      total: 1,
      data: [{ id: sessionID, time: { created: 100, updated: 200 } }],
    })
    const session = await app.request(`/session/${sessionID}`)
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      id: sessionID,
      scope: { type: "home", id: "home", local: null },
      workspace: null,
    })
  })
})

import { describe, expect, test, beforeAll } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionNav, type SessionNavEntry, type ScopeNavIndex } from "../../src/session/nav"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/scope/instance"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SessionEndpoint } from "../../src/session/endpoint"
import { Identifier } from "../../src/id/id"

Log.init({ print: false })

describe("SessionNav.buildNavIndex", () => {
  test("builds scope nav index from session info files", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let sessionA: Session.Info | undefined
    let sessionB: Session.Info | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        sessionA = await Session.create({ title: "Alpha Session" })
        sessionB = await Session.create({ title: "Beta Session" })
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const index = await SessionNav.buildNavIndex(scope.id)
        expect(index.version).toBe(1)
        expect(index.scopeID).toBe(scope.id)
        expect(index.entries.length).toBeGreaterThanOrEqual(2)

        const ids = index.entries.map((e) => e.id)
        expect(ids).toContain(sessionA!.id)
        expect(ids).toContain(sessionB!.id)

        // All entries should have category derived
        for (const entry of index.entries) {
          expect(entry.category).toBeOneOf(["project", "home", "channel", "background"])
          expect(typeof entry.title).toBe("string")
          expect(typeof entry.lastActivityAt).toBe("number")
          expect(entry.scopeID).toBe(scope.id)
        }

        // Cleanup
        await Session.remove(sessionB!.id)
        await Session.remove(sessionA!.id)
      },
    })
  })

  test("derives project category for project-scope sessions without endpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Plain Project Session" })
        const index = await SessionNav.buildNavIndex(scope.id)
        const entry = index.entries.find((e) => e.id === session.id)
        expect(entry).toBeDefined()
        expect(entry!.category).toBe("project")

        await Session.remove(session.id)
      },
    })
  })

  test("derives background category for child sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const child = await Session.create({ title: "Child", parentID: parent.id })
        const index = await SessionNav.buildNavIndex(scope.id)

        const childEntry = index.entries.find((e) => e.id === child.id)
        expect(childEntry).toBeDefined()
        expect(childEntry!.category).toBe("background")
        expect(childEntry!.parentID).toBe(parent.id)

        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })

  test("skips malformed session info without failing the build", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        // Create a valid session first
        const goodSession = await Session.create({ title: "Good" })

        // Write a malformed info.json manually
        const malformedID = Identifier.descending("session")
        const badPath = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(malformedID))
        // Write something that is not valid Session.Info JSON (missing required fields)
        await Storage.write(badPath, { corrupt: true, id: malformedID })

        // Build should succeed despite the malformed entry
        const index = await SessionNav.buildNavIndex(scope.id)
        expect(index.entries.length).toBeGreaterThanOrEqual(1)

        const goodEntry = index.entries.find((e) => e.id === goodSession.id)
        expect(goodEntry).toBeDefined()
        expect(goodEntry!.category).toBe("project")

        // The malformed entry should NOT appear in the index
        const badEntry = index.entries.find((e) => e.id === malformedID)
        expect(badEntry).toBeUndefined()

        // Cleanup
        await Session.remove(goodSession.id)
        await Storage.remove(badPath)
      },
    })
  })

  test("is idempotent: calling twice produces identical output", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Idempotency Check" })

        const index1 = await SessionNav.buildNavIndex(scope.id)
        const index2 = await SessionNav.buildNavIndex(scope.id)

        // entries should be identical (except updatedAt timestamp may differ slightly)
        expect(index1.entries.length).toBe(index2.entries.length)
        expect(index1.scopeID).toBe(index2.scopeID)
        expect(index1.version).toBe(index2.version)

        for (const e1 of index1.entries) {
          const e2 = index2.entries.find((e) => e.id === e1.id)
          expect(e2).toBeDefined()
          expect(e1.category).toBe(e2!.category)
          expect(e1.lastActivityAt).toBe(e2!.lastActivityAt)
          expect(e1.pinned).toBe(e2!.pinned)
          expect(e1.archived).toBe(e2!.archived)
        }

        await Session.remove(session.id)
      },
    })
  })

  test("entries are sorted by lastActivityAt DESC", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const older = await Session.create({ title: "Older" })
        const newer = await Session.create({ title: "Newer" })
        // Touch newer to ensure it has higher lastActivityAt
        await Session.touch(newer.id)

        const index = await SessionNav.buildNavIndex(scope.id)
        const newerIdx = index.entries.findIndex((e) => e.id === newer.id)
        const olderIdx = index.entries.findIndex((e) => e.id === older.id)

        expect(newerIdx).toBeLessThan(olderIdx)
        expect(index.entries[newerIdx].lastActivityAt).toBeGreaterThanOrEqual(index.entries[olderIdx].lastActivityAt)

        await Session.remove(newer.id)
        await Session.remove(older.id)
      },
    })
  })

  test("includes archived sessions only when present", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Will Be Archived" })
        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })

        const index = await SessionNav.buildNavIndex(scope.id)
        const entry = index.entries.find((e) => e.id === session.id)
        expect(entry).toBeDefined()
        expect(entry!.archived).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("preserves pinned state in nav entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Pinned Session" })
        await Session.update(session.id, (draft) => {
          draft.pinned = 1717000000000
        })

        const index = await SessionNav.buildNavIndex(scope.id)
        const entry = index.entries.find((e) => e.id === session.id)
        expect(entry).toBeDefined()
        expect(entry!.pinned).toBe(1717000000000)

        await Session.remove(session.id)
      },
    })
  })

  test("ignores stale session.scope.id when building index for a project scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Stale Scope Session" })

        // Simulate stale scope data: overwrite the stored scope.id to "global"
        // while the session is actually in a project scope.
        const sid = Identifier.asScopeID(scope.id)
        const ssid = Identifier.asSessionID(session.id)
        const key = StoragePath.sessionInfo(sid, ssid)
        const raw = await Storage.read<any>(key)
        raw.scope = { ...raw.scope, id: "global" }
        await Storage.write(key, raw)

        // buildNavIndex must use the authoritative scopeID parameter,
        // not the stale session.scope.id.
        const index = await SessionNav.buildNavIndex(scope.id)
        const entry = index.entries.find((e) => e.id === session.id)
        expect(entry).toBeDefined()
        expect(entry!.scopeType).toBe("project")
        expect(entry!.category).toBe("project")
        expect(entry!.scopeID).toBe(scope.id)

        await Session.remove(session.id)
      },
    })
  })
})

describe("SessionNav.rebuildAllNavIndexes", () => {
  test("rebuilds nav indexes for all scopes", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    await Instance.provide({
      scope: scopeA,
      fn: async () => {
        await Session.create({ title: "A1" })
      },
    })
    await Instance.provide({
      scope: scopeB,
      fn: async () => {
        await Session.create({ title: "B1" })
      },
    })

    let progressCalls: Array<{ done: number; total: number }> = []
    await SessionNav.rebuildAllNavIndexes((done, total) => {
      progressCalls.push({ done, total })
    })

    // Progress should have been reported
    expect(progressCalls.length).toBeGreaterThan(0)

    // Both scopes should have nav indexes now
    const indexA = await SessionNav.readNavIndex(scopeA.id)
    const indexB = await SessionNav.readNavIndex(scopeB.id)

    expect(indexA.scopeID).toBe(scopeA.id)
    expect(indexA.entries.length).toBeGreaterThanOrEqual(1)
    expect(indexB.scopeID).toBe(scopeB.id)
    expect(indexB.entries.length).toBeGreaterThanOrEqual(1)

    // Cleanup
    const sessionsA = await Instance.provide({
      scope: scopeA,
      fn: async () => {
        const s = await Session.list({ limit: 100 })
        return s.data
      },
    })
    const sessionsB = await Instance.provide({
      scope: scopeB,
      fn: async () => {
        const s = await Session.list({ limit: 100 })
        return s.data
      },
    })
    // Can't easily clean up in the right scope context, skip explicit cleanup
  })
})

test("sets endpointKind on entries from session endpoint info", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()

  await Instance.provide({
    scope,
    fn: async () => {
      const channelSession = await Session.create({
        title: "Channel DM",
        endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "acc", chatId: "chat-1" }),
      })
      const holosSession = await Session.create({
        title: "Holos Friend",
        endpoint: SessionEndpoint.holos("agent-42"),
      })
      const plainSession = await Session.create({ title: "Plain Project" })

      const index = await SessionNav.buildNavIndex(scope.id)

      const channelEntry = index.entries.find((e) => e.id === channelSession.id)
      expect(channelEntry).toBeDefined()
      expect(channelEntry!.endpointKind).toBe("channel")
      expect(channelEntry!.category).toBe("channel")

      const holosEntry = index.entries.find((e) => e.id === holosSession.id)
      expect(holosEntry).toBeDefined()
      expect(holosEntry!.endpointKind).toBe("holos")
      expect(holosEntry!.category).toBe("channel")

      const plainEntry = index.entries.find((e) => e.id === plainSession.id)
      expect(plainEntry).toBeDefined()
      expect(plainEntry!.endpointKind).toBeUndefined()
      expect(plainEntry!.category).toBe("project")

      await Session.remove(channelSession.id)
      await Session.remove(holosSession.id)
      await Session.remove(plainSession.id)
    },
  })
})

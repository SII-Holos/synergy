import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

Log.init({ print: false })

describe("GET /global/recent", () => {
  test("returns 200 with expected response shape (items, nextCursor, total, unreadCompletionCount)", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/recent")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty("items")
        expect(body).toHaveProperty("total")
        expect(body).toHaveProperty("nextCursor")
        expect(body).toHaveProperty("unreadCompletionCount")
        expect(Array.isArray(body.items)).toBe(true)
        expect(typeof body.total).toBe("number")
        expect(typeof body.unreadCompletionCount).toBe("number")
      },
    })
  })

  test("counts unread completions before pagination and excludes children and archived sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const marker = `Unread Count ${scope.id}`
        const unread = await Session.create({ title: `${marker} Unread Outside Page` })
        await Session.recordCompletionNotice(unread.id)
        await Session.recordCompletionNotice(unread.id)

        const parent = await Session.create({ title: `${marker} Parent` })
        const child = await Session.create({ title: `${marker} Unread Child`, parentID: parent.id })
        await Session.recordCompletionNotice(child.id)

        const archived = await Session.create({ title: `${marker} Archived Unread` })
        await Session.recordCompletionNotice(archived.id)
        await Session.update(archived.id, (draft) => {
          draft.time.archived = Date.now()
        })

        await Bun.sleep(50)
        const newest = await Session.create({ title: `${marker} Newest Read Session` })

        const app = Server.App()
        const res = await app.request(`/global/recent?limit=1&search=${encodeURIComponent(marker)}`)
        expect(res.status).toBe(200)
        const body = await res.json()

        expect(body.items).toHaveLength(1)
        expect(body.items[0]?.id).toBe(newest.id)
        expect(body.items[0]?.id).not.toBe(unread.id)
        expect(body.unreadCompletionCount).toBe(2)

        await Session.remove(child.id)
        await Session.remove(parent.id)
        await Session.remove(archived.id)
        await Session.remove(newest.id)
        await Session.remove(unread.id)
      },
    })
  })

  test("merges sessions across multiple scopes sorted by lastActivityAt DESC", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    let sessionA: Session.Info | undefined
    let sessionB: Session.Info | undefined

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        sessionA = await Session.create({ title: "Alpha Global" })
      },
    })
    await ScopeContext.provide({
      scope: scopeB,
      fn: async () => {
        sessionB = await Session.create({ title: "Beta Global" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/recent")
        const body = await res.json()

        const ids = body.items.map((s: any) => s.id)
        expect(ids).toContain(sessionA!.id)
        expect(ids).toContain(sessionB!.id)

        // Items should be sorted by lastActivityAt DESC
        for (let i = 1; i < body.items.length; i++) {
          expect(body.items[i - 1].lastActivityAt).toBeGreaterThanOrEqual(body.items[i].lastActivityAt)
        }

        await Session.remove(sessionA!.id)
        await Session.remove(sessionB!.id)
      },
    })
  })

  test("returns sessions from all scopes including home", async () => {
    await using tmpA = await tmpdir({ git: true })
    const scope = await tmpA.scope()

    let projectSession: Session.Info | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        projectSession = await Session.create({ title: "Project Global" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        // Create a home session
        const homeSession = await Session.create({ title: "Home Chat" })

        const app = Server.App()
        const res = await app.request("/global/recent")
        const body = await res.json()

        // Sessions from ALL scopes (home + project) are included
        for (const item of body.items) {
          expect(["home", "project"]).toContain(item.scopeType)
        }

        await Session.remove(homeSession.id)
        // The project session was created in different scope context, skip cleanup
      },
    })
  })

  test("filters GitHub sessions across scopes and includes child sessions when requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const marker = `GitHub Global Route ${crypto.randomUUID()}`

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: `${marker} Parent`, provenance: "github" })
        const child = await Session.create({
          title: `${marker} Child`,
          parentID: parent.id,
          provenance: "github",
        })
        const regular = await Session.create({ title: `${marker} Regular` })

        const app = Server.App()
        const res = await app.request(
          `/global/recent?category=github&parentOnly=false&search=${encodeURIComponent(marker)}`,
        )
        expect(res.status).toBe(200)
        const body = await res.json()

        expect(body.total).toBe(2)
        expect(body.items.map((entry: { id: string }) => entry.id).sort()).toEqual([child.id, parent.id].sort())

        await Session.remove(regular.id)
        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })

  test("returns 400 for invalid limit", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/recent?limit=-1")
        expect(res.status).toBe(400)
      },
    })
  })
})

describe("GET /global/pinned", () => {
  test("returns 200 with expected response shape", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/pinned")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty("items")
        expect(body).toHaveProperty("total")
        expect(Array.isArray(body.items)).toBe(true)
      },
    })
  })

  test("returns pinned sessions independent of recent activity window", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let pinnedID: string | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Pinned Old" })
        // Set pinned and make it look old
        await Session.update(session.id, (draft) => {
          draft.pinned = 1717000000000
          draft.time.updated = 1000 // very old
        })
        pinnedID = session.id

        // Create newer unpinned sessions
        await Session.create({ title: "Newer 1" })
        await Session.create({ title: "Newer 2" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/pinned")
        const body = await res.json()

        // Pinned session should appear regardless of age
        const pinnedItem = body.items.find((s: any) => s.id === pinnedID!)
        expect(pinnedItem).toBeDefined()
        expect(pinnedItem.pinned).toBeGreaterThan(0)

        await Session.remove(pinnedID!)
      },
    })
  })

  test("pinned items are sorted by lastActivityAt DESC", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const pinnedIDs: string[] = []

    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 3; i++) {
          const s = await Session.create({ title: `Pinned ${i}` })
          await Session.update(s.id, (draft) => {
            draft.pinned = 1000 + i
          })
          pinnedIDs.push(s.id)
        }
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/pinned")
        const body = await res.json()

        expect(body.items.length).toBeGreaterThanOrEqual(3)

        for (let i = 1; i < body.items.length; i++) {
          expect(body.items[i - 1].lastActivityAt).toBeGreaterThanOrEqual(body.items[i].lastActivityAt)
        }

        for (const id of pinnedIDs) {
          await Session.remove(id)
        }
      },
    })
  })

  test("items have required nav entry fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let sessionID: string | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const s = await Session.create({ title: "Pinned Field Check" })
        await Session.update(s.id, (draft) => {
          draft.pinned = Date.now()
        })
        sessionID = s.id
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/pinned")
        const body = await res.json()

        const item = body.items.find((s: any) => s.id === sessionID!)
        expect(item).toBeDefined()
        expect(item.id).toBeTypeOf("string")
        expect(item.title).toBeTypeOf("string")
        expect(item.category).toBeOneOf(["project", "home", "channel", "background"])
        expect(item.scopeID).toBeTypeOf("string")
        expect(item.pinned).toBeGreaterThan(0)

        await Session.remove(sessionID!)
      },
    })
  })
})

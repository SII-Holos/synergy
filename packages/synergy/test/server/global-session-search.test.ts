import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

Log.init({ print: false })

describe("GET /global/session", () => {
  test("returns 200 with expected response shape (data, total, offset, limit)", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/session")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({
          data: expect.any(Array),
          total: expect.any(Number),
          offset: expect.any(Number),
          limit: expect.any(Number),
        })
      },
    })
  })

  test("aggregates sessions across scopes", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    let sessionA: Session.Info | undefined
    let sessionB: Session.Info | undefined

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        sessionA = await Session.create({ title: "Alpha-Scope" })
      },
    })
    await ScopeContext.provide({
      scope: scopeB,
      fn: async () => {
        sessionB = await Session.create({ title: "Beta-Scope" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/session")
        expect(res.status).toBe(200)
        const body = await res.json()

        const ids = body.data.map((s: any) => s.id)
        expect(ids).toContain(sessionA!.id)
        expect(ids).toContain(sessionB!.id)

        for (const s of body.data) {
          expect(s).toHaveProperty("id")
          expect(s).toHaveProperty("title")
          expect(s).toHaveProperty("scope")
          expect(s.scope).toHaveProperty("id")
        }

        // cleanup
        await Session.remove(sessionA!.id)
        await Session.remove(sessionB!.id)
      },
    })
  })

  test("filters by search query across scopes", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    let needle: Session.Info | undefined
    let hay1: Session.Info | undefined
    let hay2: Session.Info | undefined

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        needle = await Session.create({ title: "FindMe-Here" })
        hay1 = await Session.create({ title: "Other-Session" })
      },
    })
    await ScopeContext.provide({
      scope: scopeB,
      fn: async () => {
        hay2 = await Session.create({ title: "Another-Session" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/session?search=FindMe")
        expect(res.status).toBe(200)
        const body = await res.json()

        const ids = body.data.map((s: any) => s.id)
        expect(ids).toContain(needle!.id)
        expect(ids).not.toContain(hay1!.id)
        expect(ids).not.toContain(hay2!.id)

        // cleanup
        await Session.remove(needle!.id)
        await Session.remove(hay1!.id)
        await Session.remove(hay2!.id)
      },
    })
  })

  test("excludes child sessions by default (parentOnly=true), includes them when parentOnly=false", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let parentID: string | undefined
    let childID: string | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent Session" })
        parentID = parent.id
        const child = await Session.create({ title: "Child Session", parentID: parent.id })
        childID = child.id
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()

        // Default (parentOnly=true) — child should not appear
        const def = await app.request("/global/session")
        const defBody = await def.json()
        const defIDs = defBody.data.map((s: any) => s.id)
        expect(defIDs).toContain(parentID!)
        expect(defIDs).not.toContain(childID!)

        // parentOnly=false — child should appear
        const all = await app.request("/global/session?parentOnly=false")
        const allBody = await all.json()
        const allIDs = allBody.data.map((s: any) => s.id)
        expect(allIDs).toContain(parentID!)
        expect(allIDs).toContain(childID!)

        // cleanup — remove child first
        await Session.remove(childID!)
        await Session.remove(parentID!)
      },
    })
  })

  test("returns item with required fields per contract", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let session: Session.Info | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        session = await Session.create({ title: "Contract Check" })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/global/session")
        const body = await res.json()

        const item = body.data.find((s: any) => s.id === session!.id)
        expect(item).toBeDefined()
        expect(item.id).toBeTypeOf("string")
        expect(item.title).toBeTypeOf("string")
        expect(item.scope).toBeDefined()
        expect(item.scope).toHaveProperty("id")
        expect(item.scope).toHaveProperty("type")
        expect(item.time).toBeDefined()
        expect(item.time).toHaveProperty("created")
        expect(item.time).toHaveProperty("updated")

        await Session.remove(session!.id)
      },
    })
  })

  test("supports archived-only filtering with accurate total and search", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const marker = `Archive Filter ${crypto.randomUUID()}`
    const markerQuery = encodeURIComponent(marker)

    let active: Session.Info | undefined
    let archivedNeedle: Session.Info | undefined
    let archivedOther: Session.Info | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        active = await Session.create({ title: `${marker} Active` })
        archivedNeedle = await Session.create({ title: `${marker} Needle` })
        archivedOther = await Session.create({ title: `${marker} Other Archived` })
        await Session.update(archivedNeedle.id, (draft) => {
          draft.time.archived = 100
        })
        await Session.update(archivedOther.id, (draft) => {
          draft.time.archived = 200
        })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const scopeQuery = `scopeID=${encodeURIComponent(scope.id)}`

        const def = await app.request(`/global/session?${scopeQuery}&search=${markerQuery}`)
        const defBody = await def.json()
        const defIDs = defBody.data.map((s: any) => s.id)
        expect(defIDs).toContain(active!.id)
        expect(defIDs).not.toContain(archivedNeedle!.id)
        expect(defIDs).not.toContain(archivedOther!.id)

        const archived = await app.request(`/global/session?${scopeQuery}&archived=only&search=${markerQuery}`)
        const archivedBody = await archived.json()
        const archivedIDs = archivedBody.data.map((s: any) => s.id)
        expect(archivedBody.total).toBe(2)
        expect(archivedIDs).toContain(archivedNeedle!.id)
        expect(archivedIDs).toContain(archivedOther!.id)
        expect(archivedIDs).not.toContain(active!.id)

        const searched = await app.request(
          `/global/session?${scopeQuery}&archived=only&search=${encodeURIComponent(`${marker} Needle`)}`,
        )
        const searchedBody = await searched.json()
        expect(searchedBody.total).toBe(1)
        expect(searchedBody.data.map((s: any) => s.id)).toEqual([archivedNeedle!.id])

        await Session.remove(archivedOther!.id)
        await Session.remove(archivedNeedle!.id)
        await Session.remove(active!.id)
      },
    })
  })

  test("removes restored sessions from archived-only results", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let session: Session.Info | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        session = await Session.create({ title: "Restore Archived" })
        await Session.update(session.id, (draft) => {
          draft.time.archived = 100
        })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()

        const archivedBefore = await app.request("/global/session?archived=only&search=Restore")
        const archivedBeforeBody = await archivedBefore.json()
        expect(archivedBeforeBody.data.map((s: any) => s.id)).toEqual([session!.id])

        const restored = await app.request(`/session/${session!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ time: { archived: 0 } }),
        })
        expect(restored.status).toBe(200)

        const archivedAfter = await app.request("/global/session?archived=only&search=Restore")
        const archivedAfterBody = await archivedAfter.json()
        expect(archivedAfterBody.total).toBe(0)
        expect(archivedAfterBody.data.map((s: any) => s.id)).not.toContain(session!.id)

        const activeAfter = await app.request("/global/session?search=Restore")
        const activeAfterBody = await activeAfter.json()
        expect(activeAfterBody.data.map((s: any) => s.id)).toContain(session!.id)

        await Session.remove(session!.id)
      },
    })
  })

  test("sorts archived sessions by archive time and scope", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    let older: Session.Info | undefined
    let newer: Session.Info | undefined

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        older = await Session.create({ title: "Older Archived" })
        await Session.update(older.id, (draft) => {
          draft.time.archived = 100
        })
      },
    })
    await ScopeContext.provide({
      scope: scopeB,
      fn: async () => {
        newer = await Session.create({ title: "Newer Archived" })
        await Session.update(newer.id, (draft) => {
          draft.time.archived = 300
        })
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()

        const byArchive = await app.request("/global/session?archived=only&sortBy=archived&sortDir=desc")
        const archiveBody = await byArchive.json()
        const archiveIDs = archiveBody.data.map((s: any) => s.id)
        expect(archiveIDs.indexOf(newer!.id)).toBeLessThan(archiveIDs.indexOf(older!.id))

        const byScope = await app.request("/global/session?archived=only&sortBy=scope&sortDir=asc")
        const scopeBody = await byScope.json()
        const matching = scopeBody.data.filter((s: any) => s.id === older!.id || s.id === newer!.id)
        expect(matching.map((s: any) => s.scope.directory)).toEqual(
          [...matching].map((s: any) => s.scope.directory).sort((a: string, b: string) => a.localeCompare(b)),
        )

        await Session.remove(newer!.id)
        await Session.remove(older!.id)
      },
    })
  })
})

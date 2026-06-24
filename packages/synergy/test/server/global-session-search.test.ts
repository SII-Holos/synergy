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
      scope: Scope.global(),
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
      scope: Scope.global(),
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
      scope: Scope.global(),
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
      scope: Scope.global(),
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
      scope: Scope.global(),
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
})

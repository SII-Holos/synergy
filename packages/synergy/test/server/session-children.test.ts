import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function childrenUrl(scopeDirectory: string, sessionID: string, query = "") {
  const params = new URLSearchParams({ directory: scopeDirectory })
  if (query) {
    const extra = new URLSearchParams(query)
    for (const [key, value] of extra) params.set(key, value)
  }
  return `/session/${sessionID}/children?${params.toString()}`
}

describe("GET /session/:sessionID/children", () => {
  test("returns paginated direct children with stable cursor pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const parent = await Session.create({ title: "Parent" })
        await Session.create({ title: "Child 1", parentID: parent.id })
        await Session.create({ title: "Child 2", parentID: parent.id })
        await Session.create({ title: "Child 3", parentID: parent.id })
        await Session.create({ title: "Child 4", parentID: parent.id })
        const firstChild = (await Session.children(parent.id))[0]!
        const grandchild = await Session.create({ title: "Grandchild", parentID: firstChild.id })

        const first = await app.request(childrenUrl(scope.directory, parent.id, "limit=2"))
        expect(first.status).toBe(200)
        const firstBody = await first.json()
        expect(firstBody.total).toBe(4)
        expect(firstBody.items).toHaveLength(2)
        expect(firstBody.nextCursor).toBeTruthy()

        const secondQuery = new URLSearchParams({
          limit: "2",
          cursorLastActivityAt: String(firstBody.nextCursor.lastActivityAt),
          cursorId: firstBody.nextCursor.id,
        }).toString()
        const second = await app.request(childrenUrl(scope.directory, parent.id, secondQuery))
        expect(second.status).toBe(200)
        const secondBody = await second.json()
        expect(secondBody.total).toBe(4)
        expect(secondBody.items).toHaveLength(2)
        expect(secondBody.nextCursor).toBeNull()

        const ids = [...firstBody.items, ...secondBody.items].map((session: any) => session.id)
        expect(new Set(ids).size).toBe(4)
        expect(ids).not.toContain(grandchild.id)

        await Session.remove(parent.id)
      },
    })
  })

  test("filters archived children unless includeArchived is true", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const parent = await Session.create({ title: "Parent" })
        const active = await Session.create({ title: "Active child", parentID: parent.id })
        const archived = await Session.create({ title: "Archived child", parentID: parent.id })
        await Session.update(archived.id, (draft) => {
          draft.time.archived = Date.now()
        })

        const normal = await app.request(childrenUrl(scope.directory, parent.id))
        expect(normal.status).toBe(200)
        const normalBody = await normal.json()
        expect(normalBody.total).toBe(1)
        expect(normalBody.items.map((session: any) => session.id)).toEqual([active.id])

        const included = await app.request(childrenUrl(scope.directory, parent.id, "includeArchived=true"))
        expect(included.status).toBe(200)
        const includedBody = await included.json()
        expect(includedBody.total).toBe(2)
        expect(includedBody.items.map((session: any) => session.id)).toContain(archived.id)

        await Session.remove(parent.id)
      },
    })
  })

  test("searches child titles and paginates the filtered result", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const parent = await Session.create({ title: "Parent" })
        await Session.create({ title: "Alpha one", parentID: parent.id })
        await Session.create({ title: "Alpha two", parentID: parent.id })
        await Session.create({ title: "Alpha three", parentID: parent.id })
        await Session.create({ title: "Beta one", parentID: parent.id })

        const first = await app.request(childrenUrl(scope.directory, parent.id, "search=alpha&limit=2"))
        expect(first.status).toBe(200)
        const firstBody = await first.json()
        expect(firstBody.total).toBe(3)
        expect(firstBody.items).toHaveLength(2)
        expect(firstBody.items.every((session: any) => session.title.toLowerCase().includes("alpha"))).toBe(true)
        expect(firstBody.nextCursor).toBeTruthy()

        const secondQuery = new URLSearchParams({
          search: "alpha",
          limit: "2",
          cursorLastActivityAt: String(firstBody.nextCursor.lastActivityAt),
          cursorId: firstBody.nextCursor.id,
        }).toString()
        const second = await app.request(childrenUrl(scope.directory, parent.id, secondQuery))
        expect(second.status).toBe(200)
        const secondBody = await second.json()
        expect(secondBody.total).toBe(3)
        expect(secondBody.items).toHaveLength(1)
        expect(secondBody.nextCursor).toBeNull()

        await Session.remove(parent.id)
      },
    })
  })

  test("requires both cursor fields when paginating", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const parent = await Session.create({ title: "Parent" })
        const response = await app.request(childrenUrl(scope.directory, parent.id, "cursorId=ses_missing_time"))
        expect(response.status).toBe(400)
        await Session.remove(parent.id)
      },
    })
  })
})

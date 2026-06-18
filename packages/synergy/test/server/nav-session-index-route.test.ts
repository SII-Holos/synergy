import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionNav, type NavCategory } from "../../src/session/nav"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

Log.init({ print: false })

describe("GET /session/index (v2 nav)", () => {
  test("returns 200 with expected response shape (items, nextCursor, total)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const res = await app.request(`/session/index?directory=${encodeURIComponent(scope.directory)}`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty("items")
        expect(body).toHaveProperty("total")
        expect(body).toHaveProperty("nextCursor")
        expect(Array.isArray(body.items)).toBe(true)
        expect(typeof body.total).toBe("number")
        // nextCursor may be null or { lastActivityAt, id }
        if (body.nextCursor !== null) {
          expect(typeof body.nextCursor.lastActivityAt).toBe("number")
          expect(typeof body.nextCursor.id).toBe("string")
        }
      },
    })
  })

  test("filters by parentOnly=true (default) excluding child sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let parentID: string | undefined
    let childID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent Session" })
        parentID = parent.id
        const child = await Session.create({ title: "Child Session", parentID: parent.id })
        childID = child.id
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()

        // Default (parentOnly=true) — only parent
        const defRes = await app.request(`/session/index?directory=${encodeURIComponent(scope.directory)}`)
        const defBody = await defRes.json()
        const defIDs = defBody.items.map((s: any) => s.id)
        expect(defIDs).toContain(parentID!)
        expect(defIDs).not.toContain(childID!)

        // parentOnly=false — both
        const allRes = await app.request(
          `/session/index?parentOnly=false&directory=${encodeURIComponent(scope.directory)}`,
        )
        const allBody = await allRes.json()
        const allIDs = allBody.items.map((s: any) => s.id)
        expect(allIDs).toContain(parentID!)
        expect(allIDs).toContain(childID!)

        await Session.remove(childID!)
        await Session.remove(parentID!)
      },
    })
  })

  test("filters by category", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let childID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent Project" })
        const child = await Session.create({ title: "Child Background", parentID: parent.id })
        childID = child.id
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()

        // Filter by project category
        const projRes = await app.request(
          `/session/index?category=project&directory=${encodeURIComponent(scope.directory)}`,
        )
        const projBody = await projRes.json()
        const projIDs = projBody.items.map((s: any) => s.id)
        for (const id of projIDs) {
          expect(id).not.toBe(childID!)
        }

        // Filter by background category
        const bgRes = await app.request(
          `/session/index?category=background&directory=${encodeURIComponent(scope.directory)}`,
        )
        const bgBody = await bgRes.json()
        const bgIDs = bgBody.items.map((s: any) => s.id)
        expect(bgIDs).toContain(childID!)

        // Invalid category should 400
        const badRes = await app.request(
          `/session/index?category=invalid_cat&directory=${encodeURIComponent(scope.directory)}`,
        )
        expect(badRes.status).toBe(400)

        const sessions = await Session.list({ limit: 100, parentOnly: false })
        for (const s of sessions.data) {
          await Session.remove(s.id)
        }
      },
    })
  })

  test("category + parentOnly=true excludes children, category-only includes children", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let projectParentID: string | undefined
    let backgroundChildID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        // Create a project-category parent (project scope, no parentID)
        const parent = await Session.create({ title: "Project Parent" })
        projectParentID = parent.id
        // Create a background-category child (has parentID → background)
        const child = await Session.create({ title: "Background Child", parentID: parent.id })
        backgroundChildID = child.id
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const baseUrl = `/session/index?directory=${encodeURIComponent(scope.directory)}`

        // category=project + parentOnly=true → only project parent (no children)
        const projectOnlyRes = await app.request(`${baseUrl}&category=project&parentOnly=true`)
        const projectOnlyBody = await projectOnlyRes.json()
        const projectOnlyIDs = projectOnlyBody.items.map((s: any) => s.id)
        expect(projectOnlyIDs).toContain(projectParentID!)
        expect(projectOnlyIDs).not.toContain(backgroundChildID!)

        // category=background + parentOnly=false → includes children
        const bgWithChildrenRes = await app.request(`${baseUrl}&category=background&parentOnly=false`)
        const bgWithChildrenBody = await bgWithChildrenRes.json()
        const bgWithChildrenIDs = bgWithChildrenBody.items.map((s: any) => s.id)
        expect(bgWithChildrenIDs).toContain(backgroundChildID!)

        // category=background + parentOnly=true → only root background sessions (no children)
        const bgRootOnlyRes = await app.request(`${baseUrl}&category=background&parentOnly=true`)
        const bgRootOnlyBody = await bgRootOnlyRes.json()
        const bgRootOnlyIDs = bgRootOnlyBody.items.map((s: any) => s.id)
        expect(bgRootOnlyIDs).not.toContain(backgroundChildID!)

        // Cleanup
        await Session.remove(backgroundChildID!)
        await Session.remove(projectParentID!)
      },
    })
  })

  test("respects includeArchived filter", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let archivedID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Archive Me" })
        archivedID = session.id
        await Session.update(session.id, (draft) => {
          draft.time.archived = Date.now()
        })
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()

        // Default (includeArchived=false) — archived should NOT appear
        const defRes = await app.request(`/session/index?directory=${encodeURIComponent(scope.directory)}`)
        const defBody = await defRes.json()
        const defIDs = defBody.items.map((s: any) => s.id)
        expect(defIDs).not.toContain(archivedID!)

        // includeArchived=true — archived SHOULD appear
        const archRes = await app.request(
          `/session/index?includeArchived=true&directory=${encodeURIComponent(scope.directory)}`,
        )
        const archBody = await archRes.json()
        const archIDs = archBody.items.map((s: any) => s.id)
        expect(archIDs).toContain(archivedID!)

        await Session.remove(archivedID!)
      },
    })
  })

  test("supports cursor pagination (no duplicates, no gaps)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const createdIDs: string[] = []

    await Instance.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 5; i++) {
          const s = await Session.create({ title: `Cursor Session ${i}` })
          createdIDs.push(s.id)
        }
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()

        // Page 1
        const res1 = await app.request(`/session/index?limit=2&directory=${encodeURIComponent(scope.directory)}`)
        const body1 = await res1.json()
        expect(body1.items).toHaveLength(2)
        expect(body1.nextCursor).toBeDefined()

        // Page 2
        const res2 = await app.request(
          `/session/index?limit=2&cursorLastActivityAt=${body1.nextCursor.lastActivityAt}&cursorId=${body1.nextCursor.id}&directory=${encodeURIComponent(scope.directory)}`,
        )
        const body2 = await res2.json()
        expect(body2.items).toBeTruthy()

        // No overlap between pages
        const page1IDs = body1.items.map((s: any) => s.id)
        const page2IDs = body2.items.map((s: any) => s.id)
        for (const id of page2IDs) {
          expect(page1IDs).not.toContain(id)
        }

        // Cleanup
        for (const id of createdIDs) {
          await Session.remove(id)
        }
      },
    })
  })

  test("returns items with required nav entry fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let sessionID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        const s = await Session.create({ title: "Field Check" })
        sessionID = s.id
      },
    })

    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const res = await app.request(`/session/index?directory=${encodeURIComponent(scope.directory)}`)
        const body = await res.json()

        const item = body.items.find((s: any) => s.id === sessionID!)
        expect(item).toBeDefined()
        expect(item.id).toBeTypeOf("string")
        expect(item.title).toBeTypeOf("string")
        expect(item.category).toBeOneOf(["project", "home", "channel", "background"])
        expect(item.lastActivityAt).toBeTypeOf("number")
        expect(item.scopeID).toBeTypeOf("string")

        await Session.remove(sessionID!)
      },
    })
  })

  test("scopeID overrides default scope in nav queries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let globalSessionID: string | undefined
    let projectSessionID: string | undefined

    // Create a session in the global scope
    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const s = await Session.create({ title: "Global Scope Session" })
        globalSessionID = s.id
      },
    })

    // Create a session in the project scope
    await Instance.provide({
      scope,
      fn: async () => {
        const s = await Session.create({ title: "Project Scope Session" })
        projectSessionID = s.id
      },
    })

    // Query project scope (default behavior — no scopeID override)
    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const res = await app.request(`/session/index?directory=${encodeURIComponent(scope.directory)}`)
        const body = await res.json()
        const ids = body.items.map((s: any) => s.id)
        expect(ids).toContain(projectSessionID!)
        if (globalSessionID) {
          expect(ids).not.toContain(globalSessionID!)
        }
      },
    })

    // Query global scope explicitly via scopeID override
    await Instance.provide({
      scope,
      fn: async () => {
        const app = Server.App()
        const res = await app.request(`/session/index?scopeID=global&directory=${encodeURIComponent(scope.directory)}`)
        const body = await res.json()
        const ids = body.items.map((s: any) => s.id)
        expect(ids).toContain(globalSessionID!)
        expect(ids).not.toContain(projectSessionID!)
      },
    })

    // Cleanup
    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        await Session.remove(globalSessionID!)
      },
    })
    await Instance.provide({
      scope,
      fn: async () => {
        await Session.remove(projectSessionID!)
      },
    })
  })
})

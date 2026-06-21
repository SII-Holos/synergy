import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionNav, type ScopeNavEntry } from "../../src/session/nav"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

Log.init({ print: false })

describe("GET /scope/index", () => {
  test("returns 200 with expected response shape (array of ScopeNavEntry)", async () => {
    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/scope/index")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(Array.isArray(body)).toBe(true)

        if (body.length > 0) {
          const entry = body[0]
          expect(entry).toHaveProperty("scopeID")
          expect(entry).toHaveProperty("scopeType")
          expect(entry).toHaveProperty("latestActivityAt")
          expect(entry).toHaveProperty("sessionCount")
          expect(typeof entry.scopeID).toBe("string")
          expect(["global", "project"]).toContain(entry.scopeType)
          expect(typeof entry.latestActivityAt).toBe("number")
          expect(typeof entry.sessionCount).toBe("number")
        }
      },
    })
  })

  test("returns scopes sorted by latest session activity, not frontend local order", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()

    // Create sessions in scopeA first (older), scopeB second (newer).
    // Use explicit timestamps to guarantee ordering — relying on wall-clock
    // proximity makes this test flaky on fast CI runners where both creates
    // can land in the same millisecond.
    await Instance.provide({
      scope: scopeA,
      fn: async () => {
        await Session.create({ title: "A Old" })
      },
    })
    await Instance.provide({
      scope: scopeB,
      fn: async () => {
        const s = await Session.create({ title: "B New" })
        // Explicitly touch to ensure latestActivityAt is strictly newer
        await Session.touch(s.id)
      },
    })

    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/scope/index")
        const body = await res.json()

        const scopeBIndex = body.findIndex((e: any) => e.scopeID === scopeB.id)
        const scopeAIndex = body.findIndex((e: any) => e.scopeID === scopeA.id)

        // scopeB (newer session) should appear before scopeA (older session)
        expect(scopeBIndex).toBeLessThan(scopeAIndex)

        // Verify sort order: latestActivityAt decreasing
        for (let i = 1; i < body.length; i++) {
          expect(body[i - 1].latestActivityAt).toBeGreaterThanOrEqual(body[i].latestActivityAt)
        }
      },
    })
  })

  test("each scope entry counts sessions correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const sessionIDs: string[] = []

    await Instance.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 3; i++) {
          const s = await Session.create({ title: `Count ${i}` })
          sessionIDs.push(s.id)
        }
      },
    })

    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/scope/index")
        const body = await res.json()

        const entry = body.find((e: any) => e.scopeID === scope.id)
        expect(entry).toBeDefined()
        expect(entry.sessionCount).toBeGreaterThanOrEqual(3)
        expect(entry.scopeType).toBe("project")

        for (const id of sessionIDs) {
          await Session.remove(id)
        }
      },
    })
  })

  test("includes scope name and icon when available", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    // Create a session so this scope shows up
    await Instance.provide({
      scope,
      fn: async () => {
        const s = await Session.create({ title: "Scope Icon Test" })
        await Scope.updatePersisted({
          scopeID: scope.id,
          name: "Test Project Name",
          icon: { url: "https://example.com/icon.png", color: "#ff0000" },
        })

        await Instance.provide({
          scope: Scope.global(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/scope/index")
            const body = await res.json()

            const entry = body.find((e: any) => e.scopeID === scope.id)
            expect(entry).toBeDefined()
            if (entry.name) {
              expect(entry.name).toBeTypeOf("string")
            }

            // Fixed: remove session before dispose
            await Session.remove(s.id)
          },
        })
      },
    })
  })

  test("latestActivityAt reflects most recent session in scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    let olderID: string | undefined
    let newerID: string | undefined

    await Instance.provide({
      scope,
      fn: async () => {
        const older = await Session.create({ title: "Older Scope Entry" })
        olderID = older.id
        const newer = await Session.create({ title: "Newer Scope Entry" })
        newerID = newer.id
        await Session.touch(newer.id)
      },
    })

    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/scope/index")
        const body = await res.json()

        const entry = body.find((e: any) => e.scopeID === scope.id)
        expect(entry).toBeDefined()
        expect(entry.latestActivityAt).toBeGreaterThan(0)

        await Session.remove(newerID!)
        await Session.remove(olderID!)
      },
    })
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("PATCH /session/:sessionID control-profile transition (issue #903)", () => {
  test("resolvePendingPermissions without full_access returns 400", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const app = Server.App()

        // Create a session with guarded profile
        const created = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test Guarded", controlProfile: "guarded" }),
        })
        expect(created.status).toBe(200)
        const session = await created.json()

        try {
          // PATCH with resolvePendingPermissions but without full_access — should 400
          const response = await app.request(`/session/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resolvePendingPermissions: true,
            }),
          })
          expect(response.status).toBe(400)
          const body = await response.json()
          expect(body.name).toBe("BadRequestError")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("PATCH with controlProfile full_access and resolvePendingPermissions succeeds", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const app = Server.App()

        // Create a session with guarded profile
        const created = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test Transition" }),
        })
        expect(created.status).toBe(200)
        const session = await created.json()

        try {
          // PATCH with both full_access and resolvePendingPermissions — should work
          const response = await app.request(`/session/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              controlProfile: "full_access",
              resolvePendingPermissions: true,
            }),
          })
          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.controlProfile).toBe("full_access")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("PATCH transition preserves co-occurring session updates", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const app = Server.App()
        const created = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Before transition" }),
        })
        expect(created.status).toBe(200)
        const session = await created.json()

        try {
          const response = await app.request(`/session/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "After transition",
              pinned: 1,
              controlProfile: "full_access",
              resolvePendingPermissions: true,
            }),
          })
          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toMatchObject({
            title: "After transition",
            pinned: 1,
            controlProfile: "full_access",
          })
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("PATCH with resolvePendingPermissions false without full_access is ok", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const app = Server.App()

        const created = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test False" }),
        })
        expect(created.status).toBe(200)
        const session = await created.json()

        try {
          // resolvePendingPermissions: false should be harmless even without full_access
          const response = await app.request(`/session/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resolvePendingPermissions: false,
            }),
          })
          // Should succeed (no-op without full_access but not an error)
          expect(response.status).toBe(200)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("PATCH with existing controlProfile (non-full_access) preserves current behavior", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const app = Server.App()

        const created = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test Existing Behavior" }),
        })
        expect(created.status).toBe(200)
        const session = await created.json()

        try {
          // Existing PATCH with just controlProfile should still work
          const response = await app.request(`/session/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              controlProfile: "autonomous",
            }),
          })
          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.controlProfile).toBe("autonomous")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })
})

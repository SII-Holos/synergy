import { describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(scope) })
}

function scopeHeaders(scope: Scope): Record<string, string> {
  return { "x-synergy-scope-id": scope.id }
}

function jsonHeaders(scope: Scope): Record<string, string> {
  return { "Content-Type": "application/json", "x-synergy-scope-id": scope.id }
}

async function enableBoss(app: ReturnType<typeof Server.App>, scope: Scope, sessionID: string): Promise<void> {
  const response = await app.request(`/workflow/session/${sessionID}`, {
    method: "PUT",
    headers: jsonHeaders(scope),
    body: JSON.stringify({ kind: "boss" }),
  })
  expect(response.status).toBe(200)
}

async function spawnWorker(app: ReturnType<typeof Server.App>, scope: Scope, bossID: string): Promise<Session.Info> {
  const response = await app.request(`/boss/session/${bossID}/worker`, {
    method: "POST",
    headers: jsonHeaders(scope),
    body: JSON.stringify({ role: "code" }),
  })
  expect(response.status).toBe(200)
  return response.json()
}

describe("boss routes", () => {
  test("GET tree returns the boss root after enabling Boss Mode", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const app = Server.App()
      await enableBoss(app, scope, session.id)

      const response = await app.request(`/boss/session/${session.id}/tree`, {
        headers: scopeHeaders(scope),
      })
      const body = await response.clone().text()
      expect(response.status, body).toBe(200)
      const json = await response.json()
      expect(json.tree).toMatchObject({
        sessionID: session.id,
        role: "boss",
        children: [],
      })
    })
  })

  test("POST worker creates a boss worker session", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const app = Server.App()
      await enableBoss(app, scope, session.id)

      const worker = await spawnWorker(app, scope, session.id)
      expect(worker.workflow?.kind).toBe("boss")
      expect(worker.parentID).toBe(session.id)
    })
  })

  test("POST assign delivers one inbox item and is idempotent per taskID", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const app = Server.App()
      await enableBoss(app, scope, session.id)
      const worker = await spawnWorker(app, scope, session.id)

      const assign = async () =>
        app.request(`/boss/session/${session.id}/assign`, {
          method: "POST",
          headers: jsonHeaders(scope),
          body: JSON.stringify({
            sessionID: worker.id,
            taskID: "task-1",
            task: "Implement the widget",
          }),
        })

      const first = await assign()
      const firstBody = await first.clone().text()
      expect(first.status, firstBody).toBe(200)
      const firstJson = await first.json()
      expect(firstJson.created).toBe(true)

      const second = await assign()
      expect(second.status).toBe(200)
      const secondJson = await second.json()
      expect(secondJson.created).toBe(false)
      expect(secondJson.itemID).toBe(firstJson.itemID)

      const items = await SessionInbox.list(worker.id)
      expect(items).toHaveLength(1)
      expect(items[0].deliveryKey).toBe(`boss:${session.id}:task-1`)

      SessionManager.unregisterRuntime(session.id)
      SessionManager.unregisterRuntime(worker.id)
    })
  })

  test("POST cancel removes the matching pending inbox item", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const app = Server.App()
      await enableBoss(app, scope, session.id)
      const worker = await spawnWorker(app, scope, session.id)

      const assigned = await app.request(`/boss/session/${session.id}/assign`, {
        method: "POST",
        headers: jsonHeaders(scope),
        body: JSON.stringify({ sessionID: worker.id, taskID: "task-1", task: "one" }),
      })
      expect(assigned.status).toBe(200)

      const response = await app.request(`/boss/session/${session.id}/cancel`, {
        method: "POST",
        headers: jsonHeaders(scope),
        body: JSON.stringify({ sessionID: worker.id, taskID: "task-1" }),
      })
      const body = await response.clone().text()
      expect(response.status, body).toBe(200)
      expect(await response.json()).toEqual({ cancelled: true })
      expect(await SessionInbox.list(worker.id)).toHaveLength(0)

      SessionManager.unregisterRuntime(session.id)
      SessionManager.unregisterRuntime(worker.id)
    })
  })

  test("GET tree rejects non-boss sessions with 409", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})

      const response = await Server.App().request(`/boss/session/${session.id}/tree`, {
        headers: scopeHeaders(scope),
      })
      const body = await response.clone().text()
      expect(response.status, body).toBe(409)
      expect(await response.json()).toMatchObject({ code: "not_boss" })
    })
  })

  test("GET tree returns 404 for a missing session", async () => {
    await withScope(async (scope) => {
      const response = await Server.App().request(`/boss/session/session_missing/tree`, {
        headers: scopeHeaders(scope),
      })
      const body = await response.clone().text()
      expect(response.status, body).toBe(404)
      expect(await response.json()).toMatchObject({ code: "not_found" })
    })
  })

  test("POST worker returns 400 when required input is missing", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const app = Server.App()
      await enableBoss(app, scope, session.id)

      const response = await app.request(`/boss/session/${session.id}/worker`, {
        method: "POST",
        headers: jsonHeaders(scope),
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
    })
  })

  test("POST session/open returns 409 when boss mode is disabled", async () => {
    const originalConfigCurrent = Config.current
    try {
      Config.current = mock(async () => ({})) as typeof Config.current
      await withScope(async (scope) => {
        const response = await Server.App().request(`/boss/session/open`, {
          method: "POST",
          headers: scopeHeaders(scope),
        })
        const body = await response.clone().text()
        expect(response.status, body).toBe(409)
        expect(await response.json()).toMatchObject({ code: "boss_disabled" })
      })
    } finally {
      Config.current = originalConfigCurrent
    }
  })

  test("POST session/open opens the boss session (channel-less local on demand)", async () => {
    const originalConfigCurrent = Config.current
    try {
      Config.current = mock(async () =>
        Config.Info.parse({ experimental: { boss_mode: true } } as unknown as Config.Info),
      ) as typeof Config.current
      await withScope(async (scope) => {
        const app = Server.App()
        const first = await app.request(`/boss/session/open`, {
          method: "POST",
          headers: scopeHeaders(scope),
        })
        const firstBody = await first.clone().text()
        expect(first.status, firstBody).toBe(200)
        const firstJson = (await first.json()) as { sessionID: string }
        const session = await Session.get(firstJson.sessionID)
        expect(session?.workflow?.kind).toBe("boss")
        expect(session?.endpoint?.kind).not.toBe("channel")

        // Repeated open reuses the same session.
        const second = await app.request(`/boss/session/open`, {
          method: "POST",
          headers: scopeHeaders(scope),
        })
        const secondJson = (await second.json()) as { sessionID: string }
        expect(secondJson.sessionID).toBe(firstJson.sessionID)
      })
    } finally {
      Config.current = originalConfigCurrent
    }
  })
})

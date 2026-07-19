import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Dag } from "../../src/session/dag"
import { Todo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"

describe("scope bootstrap snapshot", () => {
  test("returns the scoped bootstrap payload with a sync watermark", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const response = await Server.App().request("/scope/bootstrap", {
      headers: { "x-synergy-directory": scope.directory },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-synergy-epoch")).toBeTruthy()
    expect(Number(response.headers.get("x-synergy-seq"))).toBeGreaterThanOrEqual(0)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({
      scopeID: scope.id,
      path: { directory: scope.directory },
      sessions: { offset: 0, limit: 20 },
    })
  })
})

describe("session volatile batch", () => {
  test("deduplicates session IDs and returns inbox, todo, and DAG state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const session = await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Session.create({ title: "Batch state" })
        await Todo.update({
          sessionID: created.id,
          todos: [{ id: "todo_1", content: "Check batch", status: "pending", priority: "high" }],
        })
        await Dag.update({
          sessionID: created.id,
          nodes: [{ id: "node_1", content: "Batch", status: "running", deps: [] }],
        })
        return created
      },
    })

    const response = await Server.App().request("/session/batch/volatile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synergy-directory": scope.directory,
      },
      body: JSON.stringify({ sessionIDs: [session.id, session.id] }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-synergy-epoch")).toBeTruthy()
    const body = await response.json()
    expect(Object.keys(body.sessions)).toEqual([session.id])
    expect(body.sessions[session.id]).toMatchObject({
      inbox: [],
      todo: [{ id: "todo_1" }],
      dag: [{ id: "node_1" }],
    })
  })

  test("isolates missing sessions as per-session errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request("/session/batch/volatile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synergy-directory": tmp.path,
      },
      body: JSON.stringify({ sessionIDs: ["ses_missing"] }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: {},
      errors: {
        ses_missing: {
          code: "SESSION_NOT_FOUND",
          message: "Session not found",
        },
      },
    })
  })

  test("does not expose sessions from another scope", async () => {
    await using current = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })
    const currentScope = await current.scope()
    const otherScope = await other.scope()
    const session = await ScopeContext.provide({
      scope: otherScope,
      fn: () => Session.create({ title: "Other scope" }),
    })

    const response = await Server.App().request("/session/batch/volatile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synergy-directory": currentScope.directory,
      },
      body: JSON.stringify({ sessionIDs: [session.id] }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: {},
      errors: {
        [session.id]: {
          code: "SESSION_NOT_FOUND",
          message: "Session not found",
        },
      },
    })
  })

  test("isolates archived sessions as per-session errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const session = await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Session.create({ title: "Archived batch state" })
        return Session.update(created.id, (draft) => {
          draft.time.archived = Date.now()
        })
      },
    })

    const response = await Server.App().request("/session/batch/volatile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synergy-directory": scope.directory,
      },
      body: JSON.stringify({ sessionIDs: [session.id] }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: {},
      errors: {
        [session.id]: {
          code: "SESSION_ARCHIVED",
          message: "Session archived",
        },
      },
    })
  })

  test("rejects batches larger than 50 sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request("/session/batch/volatile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synergy-directory": tmp.path,
      },
      body: JSON.stringify({ sessionIDs: Array.from({ length: 51 }, (_, index) => `ses_${index}`) }),
    })

    expect(response.status).toBe(400)
  })
})

describe("sync route contracts", () => {
  test("publishes stable OpenAPI operation IDs", async () => {
    const spec = await Server.openapi()
    expect(spec.paths["/scope/bootstrap"]?.get?.operationId).toBe("scope.bootstrap")
    expect(spec.paths["/session/batch/volatile"]?.post?.operationId).toBe("session.volatileBatch")
  })

  test("caches scoped cross-origin preflight responses", async () => {
    const response = await Server.App().request("/scope/bootstrap", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-synergy-directory",
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-max-age")).toBe("600")
  })
})

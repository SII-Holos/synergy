import { describe, expect, test } from "bun:test"
import {
  createSynergyClient,
  type Event,
  type ScopeBootstrapResponse,
  type Session,
  type SessionMessagePage,
  type Todo,
} from "@ericsanchezok/synergy-sdk/client"
import { createSdkRuntimeAdapter } from "../src/sdk-adapter"

function session(id = "s1"): Session {
  return {
    id,
    scope: { type: "project", id: "scope-1", directory: "/workspace" },
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

function bootstrap(): ScopeBootstrapResponse {
  return {
    scopeID: "scope-1",
    provider: {
      all: [],
      connected: [],
      default: {},
      configProviders: [],
      catalogProviders: [],
      profiles: {},
      authHealth: {},
      runtimeAvailability: {},
    },
    agent: [],
    config: {},
    command: [],
    sessions: { data: [session()], total: 1, offset: 0, limit: 50 },
    cortex: [],
  }
}

function page(nextCursor: string | null = null): SessionMessagePage {
  return { items: [], referencedRoots: [], nextCursor, hasMore: nextCursor !== null, total: 0 }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  })
}

function memoryFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) =>
      handler(input instanceof Request ? input : new Request(input, init)),
    { preconnect: fetch.preconnect },
  )
}

describe("SDK runtime adapter", () => {
  test("maps snapshots, replay, SSE, resources, and interactions", async () => {
    const requests: Request[] = []
    const event: Extract<Event, { type: "session.updated" }> = {
      type: "session.updated",
      properties: { info: session("s2") },
      seq: 8,
      epoch: "epoch-1",
    }
    const client = createSynergyClient({
      baseUrl: "http://runtime.test",
      scopeID: "scope-1",
      fetch: memoryFetch(async (request) => {
        requests.push(request)
        const url = new URL(request.url)
        if (url.pathname === "/global/health") {
          return json({ healthy: true, version: "1", modelReady: true })
        }
        if (url.pathname === "/scope/bootstrap") {
          return json(bootstrap(), { headers: { "x-synergy-epoch": "epoch-1", "x-synergy-seq": "7" } })
        }
        if (url.pathname === "/permission") return json([])
        if (url.pathname === "/question") return json([])
        if (url.pathname === "/session/s1/todo") {
          return json([{ id: "todo-1", content: "ship", status: "pending", priority: "high" }] satisfies Todo[])
        }
        if (url.pathname === "/session/s1/dag") return json([])
        if (url.pathname === "/event/replay") {
          return json({ status: "ok", epoch: "epoch-1", seq: 8, events: [event] })
        }
        if (url.pathname === "/event") {
          return new Response(`id: 8\ndata: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
      }),
    })
    const adapter = createSdkRuntimeAdapter(client, { messagePageSize: 40 })

    expect(await adapter.health()).toEqual({ healthy: true, version: "1", modelReady: true })
    expect(await adapter.bootstrap()).toEqual({ data: bootstrap(), epoch: "epoch-1", seq: 7 })
    expect(await adapter.listInteractions()).toEqual({ permissions: [], questions: [] })
    expect(await adapter.sessionResources("s1")).toEqual({
      todos: [{ id: "todo-1", content: "ship", status: "pending", priority: "high" }],
      dag: [],
    })
    expect(await adapter.replay(7, "epoch-1")).toEqual({ status: "ok", epoch: "epoch-1", seq: 8, events: [event] })

    const stream = await adapter.subscribe(new AbortController().signal)
    const first = await stream[Symbol.asyncIterator]().next()
    expect(first).toEqual({ value: event, done: false })
    expect(requests.some((request) => new URL(request.url).searchParams.get("stream") === "delta")).toBe(true)
    expect(requests.every((request) => request.headers.get("x-synergy-scope-id") === "scope-1")).toBe(true)
  })

  test("aborts non-streaming requests when the request deadline expires", async () => {
    let requestSignal: AbortSignal | undefined
    const client = createSynergyClient({
      baseUrl: "http://runtime.test",
      fetch: memoryFetch(async (request) => {
        requestSignal = request.signal
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
        throw new Error("unreachable")
      }),
    })
    const adapter = createSdkRuntimeAdapter(client, { requestTimeoutMs: 10 })

    const outcome = await Promise.race([
      adapter.health().then(
        () => "resolved",
        () => "aborted",
      ),
      Bun.sleep(100).then(() => "pending"),
    ])

    expect(outcome).toBe("aborted")
    expect(requestSignal?.aborted).toBe(true)
  })

  test("replaces a stale cursor with a fresh message page", async () => {
    const cursors: Array<string | null> = []
    const client = createSynergyClient({
      baseUrl: "http://runtime.test",
      fetch: memoryFetch(async (request) => {
        const url = new URL(request.url)
        const cursor = url.searchParams.get("cursor")
        cursors.push(cursor)
        if (cursor) {
          return json(
            { name: "SessionMessagePageCursorStaleError", data: { message: "stale", anchorID: "m1" } },
            { status: 400 },
          )
        }
        return json(page("fresh"))
      }),
    })
    const adapter = createSdkRuntimeAdapter(client, { messagePageSize: 25 })

    expect(await adapter.messagePage("s1", "old")).toEqual({ ...page("fresh"), reset: true })
    expect(cursors).toEqual(["old", null])
  })

  test("maps session and interaction mutations to generated SDK routes", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const client = createSynergyClient({
      baseUrl: "http://runtime.test",
      fetch: memoryFetch(async (request) => {
        const url = new URL(request.url)
        const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text()
        const body = text ? JSON.parse(text) : undefined
        calls.push({ method: request.method, path: url.pathname, body })
        if (url.pathname === "/session" && request.method === "POST") return json(session("created"))
        if (url.pathname === "/session/s1" && request.method === "GET") return json(session())
        if (url.pathname === "/session/s1" && request.method === "PATCH") return json(session())
        if (url.pathname === "/session/s1" && request.method === "DELETE") return json(true)
        if (url.pathname === "/session/s1/input") return json({ status: "started", messageID: "m1" })
        if (url.pathname === "/session/s1/command") return new Response(null, { status: 204 })
        if (url.pathname === "/session/s1/abort") return json(true)
        if (url.pathname === "/permission/p1/reply") return json(true)
        if (url.pathname === "/question/q1/reply") return json(true)
        if (url.pathname === "/question/q2/reject") return json(true)
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
      }),
    })
    const adapter = createSdkRuntimeAdapter(client)

    expect(await adapter.getSession("s1")).toEqual(session())
    expect(await adapter.createSession("Created")).toEqual(session("created"))
    await adapter.updateSession("s1", { title: "Renamed", pinned: 3, archived: 4 })
    await adapter.deleteSession("s1")
    expect(await adapter.sendInput("s1", "hello")).toEqual({ status: "started", messageID: "m1" })
    await adapter.sendCommand("s1", "review", "--all")
    await adapter.abortSession("s1")
    await adapter.replyPermission("p1", "once", "safe")
    await adapter.replyQuestion("q1", [["A"]])
    await adapter.rejectQuestion("q2")

    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "POST", path: "/session", body: { title: "Created" } },
        { method: "PATCH", path: "/session/s1", body: { title: "Renamed", pinned: 3, time: { archived: 4 } } },
        { method: "DELETE", path: "/session/s1", body: undefined },
        { method: "POST", path: "/session/s1/input", body: { parts: [{ type: "text", text: "hello" }] } },
        { method: "POST", path: "/session/s1/command", body: { command: "review", arguments: "--all" } },
        { method: "POST", path: "/session/s1/abort", body: undefined },
        { method: "POST", path: "/permission/p1/reply", body: { reply: "once", message: "safe" } },
        { method: "POST", path: "/question/q1/reply", body: { answers: [["A"]] } },
        { method: "POST", path: "/question/q2/reject", body: undefined },
      ]),
    )
  })
})

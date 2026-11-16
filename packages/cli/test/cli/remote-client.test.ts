import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import type { RuntimeEvent } from "@ericsanchezok/synergy-local-runtime/client"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createRemoteClient } from "../../src/cli/remote-client"
import { testRuntime } from "../support/runtime"

test("the attached adapter forwards the selected Scope and mutations through the generated SDK and validates canonical replies", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const scope = Scope.home()
        const session = await Session.create({ workspace: null, environmentID: null })
        const requests: Array<{
          method: string
          path: string
          scope: string | null
          directory: string | null
          auth: string | null
          body: unknown
        }> = []
        using server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const pathname = new URL(request.url).pathname
            const content = request.method === "GET" ? "" : await request.text()
            requests.push({
              method: request.method,
              path: pathname,
              scope: request.headers.get("x-synergy-scope-id"),
              directory: request.headers.get("x-synergy-directory"),
              auth: request.headers.get("authorization"),
              body: content ? JSON.parse(content) : undefined,
            })
            if (pathname === "/scope/current") return Response.json(scope)
            if (pathname === "/session" && request.method === "POST") return Response.json(session, { status: 201 })
            if (pathname === "/session" && request.method === "GET") return Response.json({ data: [session], total: 1 })
            if (pathname.endsWith("/permissions/per_remote")) return Response.json(true)
            if (pathname === "/question/que_remote/reply" || pathname === "/question/que_remote/reject")
              return Response.json(true)
            return new Response(null, { status: 404 })
          },
        })
        const scopeID = "selected scope/研究"
        const directory = "/synthetic/项目"
        const client = createRemoteClient(
          createSynergyClient({
            baseUrl: server.url.origin,
            scopeID,
            directory,
            headers: { authorization: "Bearer synthetic-adapter-fixture" },
          }),
        )
        expect((await client.scope.current()).data).toEqual(scope)
        const created = await client.session.create({ title: "Remote input" })
        expect(created.data.id).toBe(session.id)
        expect(created.response.status).toBe(201)
        expect(created.error).toBeUndefined()
        expect((await client.session.list()).data).toMatchObject({ data: [{ id: session.id }], total: 1 })
        expect(
          (await client.permission.respond({ sessionID: session.id, permissionID: "per_remote", response: "reject" }))
            .data,
        ).toBe(true)
        expect((await client.question.reply({ requestID: "que_remote", answers: [["Keep current owner"]] })).data).toBe(
          true,
        )
        expect((await client.question.reject({ requestID: "que_remote" })).data).toBe(true)
        expect(requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
          { method: "GET", path: "/scope/current", body: undefined },
          { method: "POST", path: "/session", body: { title: "Remote input" } },
          { method: "GET", path: "/session", body: undefined },
          { method: "POST", path: `/session/${session.id}/permissions/per_remote`, body: { response: "reject" } },
          { method: "POST", path: "/question/que_remote/reply", body: { answers: [["Keep current owner"]] } },
          { method: "POST", path: "/question/que_remote/reject", body: undefined },
        ])
        expect(
          requests.every(
            (request) =>
              request.scope === encodeURIComponent(scopeID) &&
              request.directory === encodeURIComponent(directory) &&
              request.auth === "Bearer synthetic-adapter-fixture",
          ),
        ).toBe(true)
      },
    }),
  )
})

test("the attached adapter preserves structured cancellation failures and rejects invalid successful metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const error = { name: "SessionRunNotFound", data: { message: "The selected task has no current Run" } }
    let malformed = false
    const requests: string[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return malformed ? Response.json({ type: "project", id: 7 }) : Response.json(error, { status: 409 })
      },
    })
    const client = createRemoteClient(createSynergyClient({ baseUrl: server.url.origin }))
    const cancelled = await client.session.cancelRun({ sessionID: "ses_remote", runID: "msg_remote" })
    expect(cancelled.response.status).toBe(409)
    expect(cancelled.error).toEqual(error)
    expect(cancelled.data).toBeUndefined()
    await expect(client.scope.current()).rejects.toEqual(error)
    malformed = true
    await expect(client.scope.current()).rejects.toMatchObject({ name: "ZodError" })
    await expect(client.session.create({ title: "Invalid response" })).rejects.toMatchObject({ name: "ZodError" })
    expect(requests).toEqual([
      "/session/ses_remote/run/msg_remote/cancel",
      "/scope/current",
      "/scope/current",
      "/session",
    ])
  })
})

test("the attached event stream filters unsupported frames and cancels the actual HTTP subscription", async () => {
  const controller = new AbortController()
  const disconnected = Promise.withResolvers<void>()
  const permission: RuntimeEvent = {
    type: "permission.asked",
    properties: { id: "per_remote", sessionID: "ses_remote", permission: "bash", patterns: ["echo"], metadata: {} },
  }
  const question: RuntimeEvent = {
    type: "question.asked",
    properties: {
      id: "que_remote",
      sessionID: "ses_remote",
      questions: [{ header: "Choice", question: "Choose", options: [] }],
    },
  }
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/event")
      request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })
      return new Response(
        new ReadableStream({
          start(stream) {
            for (const event of [
              { type: "unrelated", properties: {} },
              { type: "permission.asked", properties: {} },
              permission,
              question,
            ])
              stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
          },
          cancel() {
            disconnected.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const client = createRemoteClient(createSynergyClient({ baseUrl: server.url.origin }))
  const events = await client.event.subscribe(undefined, { signal: controller.signal })
  const iterator = events.stream[Symbol.asyncIterator]()
  try {
    expect((await iterator.next()).value).toEqual(permission)
    expect((await iterator.next()).value).toEqual(question)
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
    await disconnected.promise
  } finally {
    controller.abort()
    await iterator.return?.()
  }
})

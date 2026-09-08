import { expect, test } from "bun:test"
import { createSynergyClient } from "../src/client"
import { buildClientParams } from "../src/gen/core/params.gen"

test("SDK auth options reach the HTTP server without replacing explicit credentials", async () => {
  const requests: { authorization: string | null; cookie: string | null; query: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({
        authorization: request.headers.get("Authorization"),
        cookie: request.headers.get("Cookie"),
        query: new URL(request.url).searchParams.get("api_key"),
      })
      return Response.json({ ok: true })
    },
  })
  try {
    const client = createSynergyClient({ baseUrl: server.url.toString(), directory: "/项目", scopeID: "scope/测试" })
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "http", scheme: "bearer" }],
        auth: async (mechanism) => {
          expect(mechanism.scheme).toBe("bearer")
          return "test-token"
        },
      },
    )
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "http", scheme: "basic" }],
        auth: "user:secret",
      },
    )
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "apiKey", in: "query", name: "api_key" }],
        auth: "query-token",
      },
    )
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "apiKey", in: "cookie", name: "session" }],
        auth: "cookie-token",
      },
    )
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "http", scheme: "bearer" }],
        auth: undefined,
      },
    )
    await client.plugin.invoke(
      "plugin",
      "read",
      {},
      {
        security: [{ type: "http", scheme: "bearer", name: "Authorization" }],
        auth: () => {
          throw new Error("Explicit authorization must not request another token")
        },
        headers: { Authorization: "Bearer caller-token" },
      },
    )
    expect(requests).toEqual([
      { authorization: "Bearer test-token", cookie: null, query: null },
      { authorization: `Basic ${btoa("user:secret")}`, cookie: null, query: null },
      { authorization: null, cookie: null, query: "query-token" },
      { authorization: null, cookie: "session=cookie-token", query: null },
      { authorization: null, cookie: null, query: null },
      { authorization: "Bearer caller-token", cookie: null, query: null },
    ])
  } finally {
    server.stop(true)
  }
})

test("SDK parameter mapping preserves whole bodies and explicit transport destinations", () => {
  expect(
    buildClientParams(
      ["session one", { text: "payload" }],
      [{ in: "path", key: "session", map: "sessionID" }, { in: "body" }],
    ),
  ).toEqual({ path: { sessionID: "session one" }, body: { text: "payload" } })

  expect(
    buildClientParams(
      [
        {
          payload: { text: "message" },
          trace: "trace-one",
          $query_directory: "/workspace",
          $headers_accept: "application/json",
          $path_sessionID: "session-one",
          ignored: "must not leak",
        },
      ],
      [
        {
          args: [
            { key: "payload", map: "body" },
            { in: "headers", key: "trace", map: "x-trace" },
          ],
        },
      ],
    ),
  ).toEqual({
    body: { text: "message" },
    headers: { "x-trace": "trace-one", accept: "application/json" },
    path: { sessionID: "session-one" },
    query: { directory: "/workspace" },
  })

  expect(buildClientParams([{ first: 1 }, { second: 2 }], [{ allowExtra: { body: false, query: true } }])).toEqual({
    query: { first: 1, second: 2 },
  })
  expect(buildClientParams([undefined, { ignored: true }], [])).toEqual({})
})

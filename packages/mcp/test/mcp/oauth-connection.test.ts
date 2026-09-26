import { afterAll, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { OAuthConnection } from "../../src/oauth-connection"
import { McpAuth } from "../../src/auth"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function fixture(kind: "http" | "sse") {
  let origin = ""
  let access = "initial-access"
  let refresh = "initial-refresh"
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let challengeCount = 0
  let refreshCount = 0
  let scope = "read"
  const challenged = Promise.withResolvers<void>()
  const refreshing = Promise.withResolvers<void>()
  const releaseRefresh = Promise.withResolvers<void>()
  const releaseLate = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  let lateChallenge = false
  let rejectRefresh = false
  let alwaysReject = false
  let challengeStatus = 401
  let toolGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let calls = 0
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.includes("oauth-protected-resource"))
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      if (url.pathname.includes("oauth-authorization-server"))
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/token") {
        const params = new URLSearchParams(await request.text())
        refreshCount++
        refreshing.resolve()
        await releaseRefresh.promise
        if (rejectRefresh || params.get("refresh_token") !== refresh)
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        refresh = `rotated-refresh-${refreshCount}`
        return Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", scope })
      }
      if (alwaysReject || request.headers.get("authorization") !== `Bearer ${access}`) {
        challengeCount++
        if (challengeCount === 2) challenged.resolve()
        if (lateChallenge && challengeCount === 2) await releaseLate.promise
        return new Response(null, {
          status: challengeStatus,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${challengeStatus === 403 ? `, error="insufficient_scope", scope="${scope}"` : ""}`,
          },
        })
      }
      if (request.method === "GET") {
        ready.resolve()
        if (kind === "http") return new Response(null, { status: 405 })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"))
            },
            cancel() {
              stream = undefined
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const message = (await request.json()) as { id?: number; method: string; params?: unknown }
      if (message.id === undefined) return new Response(null, { status: 202 })
      if (message.method === "tools/call") {
        calls++
        if (calls === 2) toolGate?.resolve()
        await toolGate?.promise
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { content: [{ type: "text", text: "pong" }] }
      const response = { jsonrpc: "2.0", id: message.id, result }
      if (kind === "http") return Response.json(response)
      stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`))
      return new Response(null, { status: 202 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    url: `${origin}/mcp`,
    ready: ready.promise,
    challenged: challenged.promise,
    refreshing: refreshing.promise,
    releaseRefresh: () => releaseRefresh.resolve(),
    releaseLate: () => releaseLate.resolve(),
    expire(options: { late?: boolean; reject?: boolean; forbidden?: boolean; always?: boolean } = {}) {
      access = "rotated-access"
      lateChallenge = options.late ?? false
      rejectRefresh = options.reject ?? false
      alwaysReject = options.always ?? false
      challengeStatus = options.forbidden ? 403 : 401
      scope = options.forbidden ? "read write" : "read"
    },
    parallelTools() {
      toolGate = Promise.withResolvers<void>()
    },
    snapshot: () => ({ refreshCount, challengeCount, calls }),
    async [Symbol.asyncDispose]() {
      releaseRefresh.resolve()
      releaseLate.resolve()
      toolGate?.resolve()
      server.stop(true)
    },
  }
}

async function connect(server: ReturnType<typeof fixture>, kind: "http" | "sse") {
  const name = crypto.randomUUID()
  await McpAuth.set(
    name,
    {
      clientInfo: { clientId: "fixture-client" },
      tokens: { accessToken: "initial-access", refreshToken: "initial-refresh", scope: "read" },
    },
    server.url,
  )
  const connection = new OAuthConnection(name, server.url, {}, { onRedirect() {} }, "background")
  const transport =
    kind === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url), { fetch: connection.fetch })
      : new SSEClientTransport(new URL(server.url), { fetch: connection.fetch })
  const client = new Client({ name: "oauth-test", version: "1" })
  await client.connect(transport)
  await server.ready
  return {
    name,
    connection,
    client,
    async [Symbol.asyncDispose]() {
      connection.dispose()
      await client.close()
    },
  }
}

test.each(["http", "sse"] as const)("%s coalesces rotating refresh without serializing tool calls", (kind) =>
  runtime.run(async () => {
    await using server = fixture(kind)
    await using current = await connect(server, kind)
    server.expire()
    server.parallelTools()
    const calls = Promise.all([1, 2].map(() => current.client.callTool({ name: "ping", arguments: {} })))
    await server.challenged
    await server.refreshing
    server.releaseRefresh()
    expect(await calls).toHaveLength(2)
    expect(server.snapshot()).toEqual({ refreshCount: 1, challengeCount: 2, calls: 2 })
    expect((await McpAuth.get(current.name))?.tokens?.refreshToken).toBe("rotated-refresh-1")
  }),
)

test("a late 401 reuses the token already refreshed by another request", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire({ late: true })
    const first = current.client.callTool({ name: "ping" })
    const second = current.client.callTool({ name: "ping" })
    await server.challenged
    server.releaseRefresh()
    await Promise.race([first, second])
    server.releaseLate()
    await Promise.all([first, second])
    expect(server.snapshot().refreshCount).toBe(1)
  }))

test.each([false, true])("refresh completion cannot mutate a newer auth owner (rejected=%s)", (reject) =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire({ reject })
    const pending = current.client.callTool({ name: "ping" }).catch((error) => error)
    await server.refreshing
    const owner = McpAuth.begin(current.name, true)
    await McpAuth.updateTokens(
      current.name,
      { accessToken: "new-login", refreshToken: "new-login-refresh" },
      server.url,
    )
    server.releaseRefresh()
    expect(await pending).toBeInstanceOf(Error)
    expect((await McpAuth.get(current.name))?.tokens).toEqual({
      accessToken: "new-login",
      refreshToken: "new-login-refresh",
    })
    owner.dispose()
  }),
)

test("403 insufficient_scope uses SDK authorization and retries once", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire({ forbidden: true })
    server.releaseRefresh()
    expect(await current.client.callTool({ name: "ping" })).toMatchObject({ content: [{ text: "pong" }] })
    expect((await McpAuth.get(current.name))?.tokens?.scope).toBe("read write")
  }))

test.each([false, true])(
  "refresh completion preserves credentials replaced within the same owner (rejected=%s)",
  (reject) =>
    runtime.run(async () => {
      await using server = fixture("http")
      await using current = await connect(server, "http")
      server.expire({ reject })
      const pending = current.client.callTool({ name: "ping" }).catch((error) => error)
      await server.refreshing
      await McpAuth.set(
        current.name,
        {
          tokens: { accessToken: "another-connection", refreshToken: "another-refresh" },
          clientInfo: { clientId: "another-client" },
        },
        server.url,
      )
      server.releaseRefresh()
      await pending
      expect(await McpAuth.get(current.name)).toMatchObject({
        tokens: { accessToken: "another-connection", refreshToken: "another-refresh" },
        clientInfo: { clientId: "another-client" },
      })
    }),
)

test("a late 401 refreshes replacement credentials that have already expired", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire({ late: true })
    const first = current.client.callTool({ name: "ping" })
    const second = current.client.callTool({ name: "ping" })
    await server.challenged
    server.releaseRefresh()
    await Promise.race([first, second])
    await McpAuth.updateTokens(
      current.name,
      {
        accessToken: "expired-replacement",
        refreshToken: "rotated-refresh-1",
        expiresAt: 1,
      },
      server.url,
    )
    server.releaseLate()
    expect(await Promise.all([first, second])).toMatchObject([
      { content: [{ text: "pong" }] },
      { content: [{ text: "pong" }] },
    ])
    expect(server.snapshot().refreshCount).toBe(2)
  }))

test("Request inputs retain method, body, options, explicit headers and cancellation", () =>
  runtime.run(async () => {
    const url = "http://127.0.0.1:1/mcp"
    const name = "request-input"
    await McpAuth.set(name, { tokens: { accessToken: "stored-token" } }, url)
    const observed: Request[] = []
    const connection = new OAuthConnection(name, url, {}, { onRedirect() {} }, "background", {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        observed.push(request)
        return Response.json({ method: request.method, body: await request.text() })
      },
    })
    try {
      const controller = new AbortController()
      const request = new Request(url, {
        method: "POST",
        body: "request-body",
        headers: { authorization: "Bearer explicit-token", "x-custom": "retained" },
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      })
      const response = await connection.fetch(request)
      expect(await response.json()).toEqual({ method: "POST", body: "request-body" })
      expect(observed[0]).toMatchObject({ credentials: "include", redirect: "error", cache: "no-store" })
      expect(observed[0]!.headers.get("authorization")).toBe("Bearer explicit-token")
      expect(observed[0]!.headers.get("x-custom")).toBe("retained")
      controller.abort(new Error("cancelled Request"))
      await expect(connection.fetch(request.clone())).rejects.toThrow("cancelled Request")
      expect(observed).toHaveLength(1)
    } finally {
      connection.dispose()
    }
  }))

test("a repeated challenge stops after one authorized replay", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire({ always: true })
    server.releaseRefresh()
    await expect(current.client.callTool({ name: "ping" })).rejects.toThrow()
    expect(server.snapshot()).toEqual({ refreshCount: 1, challengeCount: 2, calls: 0 })
  }))

test("cancelling one request preserves authentication shared by another request", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    await using current = await connect(server, "http")
    server.expire()
    const controller = new AbortController()
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" }),
    }
    const cancelled = current.connection
      .fetch(server.url, { ...request, signal: controller.signal })
      .catch((error) => error)
    const completed = current.connection.fetch(server.url, request)
    await server.challenged
    await server.refreshing
    controller.abort(new Error("caller cancelled"))
    expect((await cancelled).message).toBe("caller cancelled")
    server.releaseRefresh()
    expect((await completed).status).toBe(200)
    expect(server.snapshot().refreshCount).toBe(1)
  }))

test("explicit Authorization retains precedence over stored credentials", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    const name = "configured-authorization"
    await McpAuth.set(name, { tokens: { accessToken: "unused-token" } }, server.url)
    const headers = { authorization: "Bearer initial-access", "content-type": "application/json" }
    const connection = new OAuthConnection(name, server.url, {}, { onRedirect() {} }, "background", { headers })
    try {
      const response = await connection.fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      })
      expect(response.status).toBe(200)
      expect(server.snapshot().refreshCount).toBe(0)
    } finally {
      connection.dispose()
    }
  }))

test("an authentication deadline releases the shared operation without clearing credentials", () =>
  runtime.run(async () => {
    await using server = fixture("http")
    const name = "auth-deadline"
    await McpAuth.set(
      name,
      {
        clientInfo: { clientId: "fixture-client" },
        tokens: { accessToken: "expired", refreshToken: "initial-refresh" },
      },
      server.url,
    )
    const connection = new OAuthConnection(name, server.url, {}, { onRedirect() {} }, "background", { timeoutMs: 20 })
    try {
      await expect(connection.fetch(server.url, { method: "POST", body: "{}" })).rejects.toMatchObject({
        name: "TimeoutError",
      })
      expect((await McpAuth.get(name))?.tokens?.refreshToken).toBe("initial-refresh")
    } finally {
      connection.dispose()
    }
  }))

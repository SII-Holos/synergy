import { expect, test } from "bun:test"
import { Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import { WSContext, type WSEvents } from "hono/ws"
import { Server } from "../../src/server/server"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { HostConnection } from "@ericsanchezok/synergy-harness/host/connection"
import { HostConnectionRoute } from "../../src/server/host-connection"
import { testRuntime } from "../support/runtime"

test("remote gateway requires confirmed pairing and binds every request to its body and path", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime({ SYNERGY_SERVER_TOKEN: "target-private-fixture" })
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({
      forward: async (request) =>
        new Response(
          JSON.stringify({
            path: new URL(request.url).pathname,
            authorization: request.headers.has("authorization"),
            body: await request.text(),
          }),
        ),
      originAllowed: () => true,
    }),
  )
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const call = (path: string, init?: RequestInit) => target.run(() => app.request(path, init))
  expect((await call("/host-connection/gateway/api/global/health")).status).toBe(401)
  expect((await call("/host-connection/gateway/descriptor")).status).toBe(200)
  expect((await call("/host-connection/gateway/pair", { method: "POST", body: "{" })).status).toBe(400)
  expect((await call("/host-connection/gateway/pair", { method: "POST", body: "{}" })).status).toBe(400)
  const invite = await target.run(() => HostConnection.invite())
  const request = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
  const pending = await call("/host-connection/gateway/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  expect(pending.status).toBe(200)
  const receipt = await target.run(() => HostConnection.approve(request.requestID))
  await source.run(() => HostConnection.acceptPair(descriptor, receipt))
  const bytes = new TextEncoder().encode("fixture")
  const packet = await source.run(() =>
    HostConnection.signRequest(descriptor.id, "POST", "/session?scopeID=home", "text/plain", bytes),
  )
  const init = {
    method: "POST",
    headers: { "content-type": "text/plain", "x-synergy-host-proof": JSON.stringify(packet) },
    body: "fixture",
  }
  const response = await call("/host-connection/gateway/api/session?scopeID=home", init)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ path: "/session", authorization: true, body: "fixture" })
  expect((await call("/host-connection/gateway/api/session?scopeID=home", init)).status).toBe(401)
  const forbidden = await source.run(() =>
    HostConnection.signRequest(descriptor.id, "GET", "/host-connection/peers", "", new Uint8Array()),
  )
  expect(
    (
      await call("/host-connection/gateway/api/host-connection/peers", {
        headers: { "x-synergy-host-proof": JSON.stringify(forbidden) },
      })
    ).status,
  ).toBe(403)
  const encodedPath = "/..%2fhost-connection/peers"
  const encoded = await source.run(() =>
    HostConnection.signRequest(descriptor.id, "GET", encodedPath, "", new Uint8Array()),
  )
  expect(
    (
      await call(`/host-connection/gateway/api${encodedPath}`, {
        headers: { "x-synergy-host-proof": JSON.stringify(encoded) },
      })
    ).status,
  ).toBe(403)
}, 30_000)

test("real paired HTTP and WebSocket connections transfer a paused task and close immediately on revocation", async () => {
  await using source = await testRuntime({ SYNERGY_SERVER_TOKEN: "source-fixture" })
  await using target = await testRuntime({ SYNERGY_SERVER_TOKEN: "target-fixture" })
  const sourceServer = await source.run(() =>
    Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false }),
  )
  const targetServer = await target.run(() =>
    Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false }),
  )
  const serve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: target.bind(async (request: Request, server: Bun.Server<Parameters<typeof websocket.open>[0]["data"]>) => {
      const url = new URL(request.url)
      url.pathname = "/host-connection/gateway" + url.pathname
      return Server.App().fetch(new Request(url, request), {
        server: {
          upgrade: (_request: Request, options: Parameters<typeof server.upgrade>[1]) =>
            server.upgrade(request, options),
        },
      })
    }),
    websocket: {
      open: target.bind(websocket.open),
      message: target.bind(websocket.message),
      close: target.bind(websocket.close),
    },
  })
  let socket: WebSocket | undefined
  try {
    const targetAddress = `http://127.0.0.1:${serve.port}`
    await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target", url: targetAddress }))
    await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
    expect((await fetch(new URL("/global/health", targetServer.url))).status).toBe(401)
    expect((await fetch(`${targetAddress}/api/global/health`)).status).toBe(401)
    const descriptor = await source.run(() => HostConnection.probe(targetAddress))
    const invite = await target.run(() => HostConnection.invite())
    const pending = await source.run(() => HostConnection.pair(descriptor, invite.code))
    expect(pending.phase).toBe("pending")
    expect((await source.run(() => HostConnection.peers())).length).toBe(0)
    await target.run(() => HostConnection.approve(pending.requestID))
    expect((await source.run(() => HostConnection.finish(pending.requestID))).phase).toBe("approved")
    const peer = (await source.run(() => HostConnection.peers()))[0]
    const proxy = `${sourceServer.url.origin}${peer.connectionPath}`
    const call = (url: string, init: RequestInit = {}) =>
      fetch(url, { ...init, headers: { authorization: "Bearer source-fixture", ...init.headers } })
    expect((await fetch(`${proxy}/global/health`)).status).toBe(401)
    expect((await call(`${proxy}/global/health`)).status).toBe(200)
    const session = await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, environmentID: null })
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          return session
        },
      }),
    )
    const sourceURL = `${sourceServer.url.origin}/session-transfer/${session.id}`
    const post = (url: string, data: unknown) =>
      call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
    expect(
      (await post(`${sourceURL}/prepare?scopeID=home`, { targetID: descriptor.id, migrationID: crypto.randomUUID() }))
        .status,
    ).toBe(200)
    const archive = await call(`${sourceURL}/archive?scopeID=home`)
    const form = new FormData()
    form.set("file", new File([await archive.blob()], "session.zip"))
    const staged = await call(`${proxy}/session-transfer/stage?scopeID=home`, { method: "POST", body: form })
    expect(staged.status).toBe(200)
    const committed = await post(`${sourceURL}/commit?scopeID=home`, await staged.json())
    expect(committed.status).toBe(200)
    const activated = await post(`${proxy}/session-transfer/activate?scopeID=home`, await committed.json())
    expect(activated.status).toBe(200)
    expect((await target.run(() => Session.get(session.id))).paused).toBeDefined()
    const connected = Promise.withResolvers<string>()
    const pong = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const timer = setTimeout(() => connected.reject(new Error("Remote event stream did not connect")), 5000)
    try {
      socket = Reflect.construct(WebSocket, [
        `${proxy.replace(/^http/, "ws")}/global/event/ws`,
        { headers: { authorization: "Bearer source-fixture", origin: sourceServer.url.origin } },
      ]) as WebSocket
      socket.onopen = () => socket!.send(JSON.stringify({ payload: { type: "client.ping", properties: {} } }))
      socket.onmessage = (event) => {
        if (String(event.data).includes("server.connected")) connected.resolve(String(event.data))
        if (String(event.data).includes("server.pong")) pong.resolve()
      }
      socket.onerror = () => connected.reject(new Error("Remote event stream failed"))
      socket.onclose = (event) => {
        closed.resolve()
        connected.reject(new Error(`Remote event stream closed (${event.code})`))
      }
      expect(await connected.promise).toContain("server.connected")
      await Promise.race([
        pong.promise,
        Bun.sleep(5000).then(() => {
          throw new Error("Initial client message was lost before upstream handshake")
        }),
      ])
      await target.run(() => HostConnection.revoke(pending.requester.id))
      await Promise.race([
        closed.promise,
        Bun.sleep(5000).then(() => {
          throw new Error("Revocation left the stream connected")
        }),
      ])
      expect((await call(`${proxy}/global/health`)).status).toBe(401)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    socket?.close()
    await serve.stop(true)
    await source.run(() => sourceServer.stop(true))
    await target.run(() => targetServer.stop(true))
  }
}, 30_000)

test("HTTP response bodies lose authority on target revocation", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  const requester = await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invite = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
  await target.run(() => HostConnection.receivePair(pairing))
  await source.run(() =>
    target
      .run(() => HostConnection.approve(pairing.requestID))
      .then((receipt) => HostConnection.acceptPair(descriptor, receipt)),
  )
  let cancelled = false
  let aborted = false
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({
      originAllowed: () => true,
      forward: async (request) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true },
        )
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("retained"))
            },
            cancel() {
              cancelled = true
            },
          }),
        )
      },
    }),
  )
  const packet = await source.run(() =>
    HostConnection.signRequest(descriptor.id, "GET", "/stream", "", new Uint8Array()),
  )
  const response = await target.run(() =>
    app.request("/host-connection/gateway/api/stream", { headers: { "x-synergy-host-proof": JSON.stringify(packet) } }),
  )
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("retained")
  try {
    await target.run(() => HostConnection.revoke(requester.id))
    expect(aborted).toBe(true)
    expect(cancelled).toBe(true)
    await expect(reader.read()).rejects.toThrow()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}, 30_000)

test.each(["missing", "malformed", "disabled", "expired", "unpaired"])(
  "gateway rejects %s proof without consuming its body",
  async (kind) => {
    await using runtime = await testRuntime()
    if (kind !== "disabled")
      await runtime.run(() => HostConnection.configure("fixture", { enabled: true, name: "Fixture" }))
    const proof =
      kind === "missing"
        ? undefined
        : kind === "malformed"
          ? "{"
          : JSON.stringify({
              hostID: crypto.randomUUID(),
              pairID: crypto.randomUUID(),
              nonce: crypto.randomUUID(),
              time: kind === "expired" ? 0 : Date.now(),
              signature: "a".repeat(86),
            })
    let reads = 0
    const app = new Hono().route(
      "/host-connection",
      HostConnectionRoute({ forward: async () => new Response("business"), originAllowed: () => true }),
    )
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.enqueue(new Uint8Array([1]))
          if (reads === 2) controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const request = new Request("http://fixture/host-connection/gateway/api/session", {
      method: "POST",
      body,
      headers: proof ? { "x-synergy-host-proof": proof } : undefined,
    })
    const response = await runtime.run(() => app.fetch(request))
    expect(response.status).toBe(401)
    expect(reads).toBe(0)
  },
  30_000,
)

test("pending gateway WebSocket never invokes business open after authority withdrawal", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invitation = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
  await target.run(() => HostConnection.receivePair(pairing))
  const receipt = await target.run(() => HostConnection.approve(pairing.requestID))
  await source.run(() => HostConnection.acceptPair(descriptor, receipt))
  let opened = 0
  let closed = 0
  const events = Promise.withResolvers<WSEvents>()
  const business = new Hono().get(
    "/socket",
    upgradeWebSocket(() => ({
      onOpen() {
        opened++
      },
    })),
  )
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({ forward: async (request, env) => business.fetch(request, env), originAllowed: () => true }),
  )
  const packet = await source.run(() =>
    HostConnection.signRequest(descriptor.id, "GET", "/socket", "", new Uint8Array()),
  )
  await target.run(() =>
    app.fetch(
      new Request("http://fixture/host-connection/gateway/api/socket", {
        headers: { upgrade: "websocket", "x-synergy-host-proof": JSON.stringify(packet) },
      }),
      {
        server: {
          upgrade(_request: Request, options: { data: { events: WSEvents } }) {
            events.resolve(options.data.events)
            return true
          },
        },
      },
    ),
  )
  await target.run(() => HostConnection.revoke(pairing.requester.id))
  await target.run(() =>
    events.promise.then((callbacks) =>
      callbacks.onOpen?.(
        new Event("open"),
        new WSContext({
          close() {
            closed++
          },
          send() {},
          readyState: WebSocket.OPEN,
        }),
      ),
    ),
  )
  expect(opened).toBe(0)
  expect(closed).toBe(1)
}, 30_000)

test("source HTTP proxy keeps revocation ownership through response body settlement", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const address = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream"))
          },
        }),
      ),
  })
  const descriptor = await target.run(() =>
    HostConnection.configure("fixture", { enabled: true, name: "Target", url: `http://127.0.0.1:${address.port}` }),
  )
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invitation = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
  await target.run(() => HostConnection.receivePair(pairing))
  const receipt = await target.run(() => HostConnection.approve(pairing.requestID))
  await source.run(() => HostConnection.acceptPair(descriptor, receipt))
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({ forward: async () => new Response("unused"), originAllowed: () => true }),
  )
  try {
    const response = await source.run(() => app.request(`/host-connection/peers/${descriptor.id}/proxy/stream`))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("stream")
    try {
      await source.run(() => HostConnection.disableOwner("fixture"))
      await expect(reader.read()).rejects.toThrow()
      expect((await source.run(() => HostConnection.peers()))[0].id).toBe(descriptor.id)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } finally {
    await address.stop(true)
  }
}, 30_000)

test("pairing body admission is bounded, cancellable and releases capacity", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => HostConnection.configure("fixture", { enabled: true, name: "Fixture" }))
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({ forward: async () => new Response("unused"), originAllowed: () => true }),
  )
  app.onError(() => new Response("rejected", { status: 429 }))
  const controllers: AbortController[] = []
  const pending: Promise<Response>[] = []
  let cancelled = 0
  try {
    for (let index = 0; index < 8; index++) {
      const ready = Promise.withResolvers<void>()
      const controller = new AbortController()
      controllers.push(controller)
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            ready.resolve()
          },
          cancel() {
            cancelled++
          },
        },
        { highWaterMark: 0 },
      )
      pending.push(
        runtime.run(async () =>
          app.fetch(
            new Request(`http://fixture/host-connection/gateway/${index % 2 ? "pair/status" : "pair"}`, {
              method: "POST",
              body,
              signal: controller.signal,
            }),
          ),
        ),
      )
      await ready.promise
    }
    let reads = 0
    const excess = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    expect(
      (
        await runtime.run(() =>
          app.fetch(new Request("http://fixture/host-connection/gateway/pair", { method: "POST", body: excess })),
        )
      ).status,
    ).toBe(429)
    expect(reads).toBe(0)
  } finally {
    for (const controller of controllers) controller.abort(new Error("fixture stopped"))
    await Promise.all(pending)
  }
  expect(cancelled).toBe(8)
  expect(
    (await runtime.run(() => app.request("/host-connection/gateway/pair", { method: "POST", body: "{}" }))).status,
  ).toBe(400)
}, 30_000)

test("gateway uploads exhaust aggregate capacity before the reader-count limit", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invitation = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
  await target.run(() => HostConnection.receivePair(pairing))
  const receipt = await target.run(() => HostConnection.approve(pairing.requestID))
  await source.run(() => HostConnection.acceptPair(descriptor, receipt))
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({ forward: async () => new Response("unused"), originAllowed: () => true }),
  )
  app.onError(() => new Response("rejected", { status: 429 }))
  const controllers: AbortController[] = []
  const pending: Promise<Response>[] = []
  let cancelled = 0
  try {
    for (let index = 0; index < 2; index++) {
      const packet = await source.run(() =>
        HostConnection.signRequest(descriptor.id, "POST", "/session", "", new Uint8Array()),
      )
      const ready = Promise.withResolvers<void>()
      const controller = new AbortController()
      controllers.push(controller)
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            ready.resolve()
          },
          cancel() {
            cancelled++
          },
        },
        { highWaterMark: 0 },
      )
      pending.push(
        target.run(async () =>
          app.fetch(
            new Request("http://fixture/host-connection/gateway/api/session", {
              method: "POST",
              headers: { "x-synergy-host-proof": JSON.stringify(packet) },
              body,
              signal: controller.signal,
            }),
          ),
        ),
      )
      await ready.promise
    }
    let reads = 0
    const excess = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const response = await target.run(() =>
      app.fetch(
        new Request("http://fixture/host-connection/gateway/pair", {
          method: "POST",
          body: excess,
        }),
      ),
    )
    expect(response.status).toBe(429)
    expect(reads).toBe(0)
  } finally {
    for (const controller of controllers) controller.abort(new Error("fixture stopped"))
    await Promise.all(pending)
  }
  expect(cancelled).toBe(2)
  expect(
    (await target.run(() => app.request("/host-connection/gateway/pair", { method: "POST", body: "{}" }))).status,
  ).toBe(400)
}, 30_000)

test("the anonymous pairing read deadline cancels the reader and returns its capacity", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => HostConnection.configure("fixture", { enabled: true, name: "Fixture" }))
  const app = new Hono().route(
    "/host-connection",
    HostConnectionRoute({ forward: async () => new Response("unused"), originAllowed: () => true }),
  )
  app.onError(() => new Response("rejected", { status: 429 }))
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {},
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const response = await runtime.run(() =>
    app.fetch(
      new Request("http://fixture/host-connection/gateway/pair/status", {
        method: "POST",
        body,
      }),
    ),
  )
  expect(response.status).toBe(429)
  expect(cancelled).toBe(true)
  expect(
    (await runtime.run(() => app.request("/host-connection/gateway/pair", { method: "POST", body: "{}" }))).status,
  ).toBe(400)
}, 40_000)

import { expect, test } from "bun:test"
import { Hono } from "hono"
import { websocket } from "hono/bun"
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

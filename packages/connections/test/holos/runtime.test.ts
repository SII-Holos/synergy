import { afterEach, describe, expect, test } from "bun:test"
import { HolosAccounts } from "../../src/holos/accounts"
import { HolosProvider } from "../../src/holos/runtime"
import { Presence } from "../../src/holos/presence"

const testAgentID = "holos-runtime-send-test"

afterEach(async () => {
  await HolosAccounts.deleteAccount(testAgentID)
  Presence.clear()
})

describe("HolosProvider endpoint configuration", () => {
  test("preserves configured base paths for the token and WebSocket routes", async () => {
    const requests: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        requests.push(`${url.pathname}${url.search}`)
        if (url.pathname === "/environment/api/v1/holos/agent_tunnel/ws_token") {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname === "/environment/api/v1/holos/agent_tunnel/ws" && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: { message() {} },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}/environment`,
          wsUrl: `ws://127.0.0.1:${server.port}/environment`,
          portalUrl: `http://127.0.0.1:${server.port}/environment`,
        },
        signal: abort.signal,
      })

      expect(requests).toEqual([
        "/environment/api/v1/holos/agent_tunnel/ws_token",
        "/environment/api/v1/holos/agent_tunnel/ws?token=test-token",
      ])
    } finally {
      abort.abort()
    }
  })
})

describe("HolosProvider send delivery", () => {
  test("treats the absence of ws_failed during the failure window as delivered", async () => {
    const received = Promise.withResolvers<Record<string, unknown>>()
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        message(_socket, message) {
          received.resolve(JSON.parse(String(message)) as Record<string, unknown>)
        },
      },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          portalUrl: `http://127.0.0.1:${server.port}`,
        },
        signal: abort.signal,
      })

      const resultPromise = provider.send("target-agent", "test.event", { value: "ok" })
      const envelope = await received.promise

      expect(envelope).toMatchObject({
        type: "ws_send",
        meta: { target_agent_id: "target-agent", event: "test.event" },
        payload: { value: "ok" },
      })
      await expect(resultPromise).resolves.toEqual({ sent: true })
    } finally {
      abort.abort()
    }
  })

  test("reports ws_failed received during the failure window", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        message(socket, message) {
          const envelope = JSON.parse(String(message)) as { request_id: string }
          socket.send(
            JSON.stringify({
              type: "ws_failed",
              request_id: envelope.request_id,
              meta: { code: "OFFLINE", message: "Target is offline" },
              payload: null,
              caller: null,
            }),
          )
        },
      },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          portalUrl: `http://127.0.0.1:${server.port}`,
        },
        signal: abort.signal,
      })

      await expect(provider.send("target-agent", "test.event", { value: "ok" })).resolves.toEqual({
        sent: false,
        reason: "delivery_failed",
      })
    } finally {
      abort.abort()
    }
  })

  test("settles an in-flight send when the websocket disconnects", async () => {
    const connected = Promise.withResolvers<void>()
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        open() {
          connected.resolve()
        },
        message(socket) {
          socket.close()
        },
      },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          portalUrl: `http://127.0.0.1:${server.port}`,
        },
        signal: abort.signal,
      })
      await connected.promise

      await expect(provider.send("target-agent", "test.event", { value: "ok" })).resolves.toEqual({
        sent: false,
        reason: "disconnected",
      })
    } finally {
      abort.abort()
    }
  })

  test("closes the websocket and settles in-flight sends when the runtime signal aborts", async () => {
    const closed = Promise.withResolvers<void>()
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        close() {
          closed.resolve()
        },
        message() {},
      },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
    await provider.connect({
      config: {
        enabled: true,
        apiUrl: `http://127.0.0.1:${server.port}`,
        wsUrl: `ws://127.0.0.1:${server.port}`,
        portalUrl: `http://127.0.0.1:${server.port}`,
      },
      signal: abort.signal,
    })

    const pending = provider.send("target-agent", "test.event", { value: "ok" })
    abort.abort()

    await expect(pending).resolves.toEqual({ sent: false, reason: "disconnected" })
    await expect(Promise.race([closed.promise, Bun.sleep(500).then(() => "timeout")])).resolves.not.toBe("timeout")
    await expect(provider.send("target-agent", "test.event", { value: "after-abort" })).resolves.toEqual({
      sent: false,
      reason: "not_connected",
    })
  })
})

test("does not block an explicit send on a cached offline presence mark", async () => {
  const received = Promise.withResolvers<Record<string, unknown>>()
  using server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/ws_token")) {
        return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
      }
      if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      message(_socket, message) {
        received.resolve(JSON.parse(String(message)) as Record<string, unknown>)
      },
    },
  })
  const abort = new AbortController()
  const provider = new HolosProvider()

  try {
    await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
    await provider.connect({
      config: {
        enabled: true,
        apiUrl: `http://127.0.0.1:${server.port}`,
        wsUrl: `ws://127.0.0.1:${server.port}`,
        portalUrl: `http://127.0.0.1:${server.port}`,
      },
      signal: abort.signal,
    })

    Presence.markOffline("target-agent")
    const resultPromise = provider.send("target-agent", "test.event", { value: "ok" })
    const envelope = await received.promise

    expect(envelope).toMatchObject({ type: "ws_send", meta: { target_agent_id: "target-agent" } })
    await expect(resultPromise).resolves.toEqual({ sent: true })
    expect(Presence.get("target-agent")).toBe("online")
  } finally {
    abort.abort()
  }
})

test("invalidates presence when the websocket disconnects", async () => {
  const connected = Promise.withResolvers<void>()
  using server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/ws_token")) {
        return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
      }
      if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      open() {
        connected.resolve()
      },
      message(socket) {
        socket.close()
      },
    },
  })
  const abort = new AbortController()
  const provider = new HolosProvider()

  try {
    await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
    await provider.connect({
      config: {
        enabled: true,
        apiUrl: `http://127.0.0.1:${server.port}`,
        wsUrl: `ws://127.0.0.1:${server.port}`,
        portalUrl: `http://127.0.0.1:${server.port}`,
      },
      signal: abort.signal,
    })
    await connected.promise

    Presence.markOnline("target-agent")
    Presence.markOffline("other-agent")
    expect(Presence.all().size).toBe(2)

    await provider.send("target-agent", "test.event", { value: "ok" }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(Presence.all().size).toBe(0)
  } finally {
    abort.abort()
  }
})

describe("HolosProvider heartbeat liveness", () => {
  test("keeps the tunnel open while the gateway returns pong frames", async () => {
    let pingCount = 0
    const disconnected = Promise.withResolvers<string | undefined>()
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        message(socket, message) {
          const envelope = JSON.parse(String(message)) as { type?: string }
          if (envelope.type !== "ping") return
          pingCount++
          socket.send(
            JSON.stringify({
              type: "pong",
              request_id: null,
              meta: { timestamp: Date.now() },
              payload: null,
              caller: null,
            }),
          )
        },
      },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          portalUrl: `http://127.0.0.1:${server.port}`,
        },
        signal: abort.signal,
        onDisconnect: (reason) => disconnected.resolve(reason),
        heartbeat: { intervalMs: 20, pongDeadlineMs: 80 },
      })

      await Bun.sleep(180)

      expect(pingCount).toBeGreaterThanOrEqual(4)
      await expect(Promise.race([disconnected.promise, Bun.sleep(20).then(() => "still_connected")])).resolves.toBe(
        "still_connected",
      )
    } finally {
      abort.abort()
    }
  })

  test("closes a silent tunnel and terminalizes pending native work as ambiguous", async () => {
    const disconnected = Promise.withResolvers<string | undefined>()
    using server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "test-token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws") && server.upgrade(request)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: { message() {} },
    })
    const abort = new AbortController()
    const provider = new HolosProvider()

    try {
      await HolosAccounts.saveAndActivateAccount(testAgentID, "test-secret")
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          portalUrl: `http://127.0.0.1:${server.port}`,
        },
        signal: abort.signal,
        onDisconnect: (reason) => disconnected.resolve(reason),
        heartbeat: { intervalMs: 20, pongDeadlineMs: 80 },
      })

      const requestID = crypto.randomUUID()
      const pending = provider.sendNativeRequest({
        type: "clarus.runtime.task.result.record",
        payload: { success: true },
        requestID,
        expectedResponseType: "clarus.runtime.task.result.recorded",
      })
      const pendingFailure = expect(pending).rejects.toMatchObject({
        disposition: "ambiguous",
        requestID,
        reason: "transport_liveness_lost",
      })

      await expect(Promise.race([disconnected.promise, Bun.sleep(1_000).then(() => "timeout")])).resolves.toBe(
        "transport_liveness_lost",
      )
      await pendingFailure
      await expect(provider.send("target-agent", "test.event", {})).resolves.toEqual({
        sent: false,
        reason: "not_connected",
      })
    } finally {
      abort.abort()
    }
  })
})

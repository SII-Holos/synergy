import { afterEach, describe, expect, test } from "bun:test"
import { HolosAccounts } from "../../src/holos/accounts"
import { HolosProvider } from "../../src/holos/runtime"
import { Presence } from "../../src/holos/presence"

const testAgentID = "holos-runtime-send-test"

afterEach(async () => {
  await HolosAccounts.deleteAccount(testAgentID)
  Presence.clear()
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
        reason: "not_connected",
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

    await expect(pending).resolves.toEqual({ sent: false, reason: "not_connected" })
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

import { expect, test } from "bun:test"
import { ComputerBrokerClient } from "../../src/computer/broker-client"

test("the broker registers, reports native prerequisites, and rejects invalid commands", async () => {
  const registered = Promise.withResolvers<unknown>()
  const result = Promise.withResolvers<unknown>()
  const closed = Promise.withResolvers<number>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/computer/host/broker" && server.upgrade(request)) return
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.type === "register") {
          registered.resolve(message)
          socket.send(JSON.stringify({ type: "registered", version: 1 }))
          socket.send(JSON.stringify({ type: "cancel", id: "unknown" }))
          socket.send(JSON.stringify({ type: "command", id: "apps", owner: "task", command: { type: "apps" } }))
        } else {
          result.resolve(message)
          socket.send(JSON.stringify({ type: "command", id: "invalid", owner: "task", command: { type: "script" } }))
        }
      },
      close(_socket, code) {
        closed.resolve(code)
      },
    },
  })
  const client = new ComputerBrokerClient({
    serverUrl: server.url.href,
    token: "a".repeat(64),
    executable: "/nonexistent/synergy-computer-driver",
    checkPermissions() {
      throw new Error("Accessibility required")
    },
  })
  try {
    client.connect()
    client.connect()
    expect(await registered.promise).toEqual({ type: "register", version: 1, token: "a".repeat(64) })
    expect(await result.promise).toMatchObject({
      type: "error",
      id: "apps",
      code: process.platform === "darwin" ? "computer_host_error" : "computer_platform_unsupported",
    })
    expect(await closed.promise).toBe(1008)
  } finally {
    await client.close()
    // Let Bun finish the WebSocket close callback before awaiting server shutdown.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await server.stop(true)
  }
})

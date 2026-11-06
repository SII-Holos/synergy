import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

test("event client contributions follow raw sockets, reject stale interests and release with transport", async () => {
  const connections: Array<{
    id: string
    received: unknown[]
    active: unknown[]
    disposed: number
    send(frame: { scopeID: string | null; payload: { type: string; properties: Record<string, unknown> } }): boolean
  }> = []
  await using runtime = await testRuntime(undefined, () => {
    Server.registerContributions({
      eventClients: [
        {
          connect({ clientId, send }) {
            const connection = { id: clientId, send, received: [] as unknown[], active: [] as unknown[], disposed: 0 }
            connections.push(connection)
            return {
              receive: (payload) => connection.received.push(payload),
              active: (active) => connection.active.push(active),
              dispose: () => connection.disposed++,
            }
          },
        },
      ],
    })
  })
  await runtime.run(async () => {
    const server = Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false })
    const sockets: WebSocket[] = []
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("event contribution did not settle")
        await Bun.sleep(5)
      }
    }
    const connect = async () => {
      const url = new URL("/global/event/ws?stream=projection-v2", server.url)
      url.protocol = "ws:"
      const Socket = WebSocket as typeof WebSocket & {
        new (url: URL, options: { headers: Record<string, string> }): WebSocket
      }
      const socket = new Socket(url, { headers: { origin: server.url.origin } })
      sockets.push(socket)
      const frames: Array<{ payload: { type: string } }> = []
      socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))
      const send = (type: string, properties: Record<string, unknown>) =>
        socket.send(JSON.stringify({ payload: { type, properties } }))
      const barrier = async () => {
        const before = frames.filter((frame) => frame.payload.type === "server.pong").length
        send("client.ping", {})
        await wait(() => frames.filter((frame) => frame.payload.type === "server.pong").length > before)
      }
      await wait(() => frames.some((frame) => frame.payload.type === "server.connected"))
      return { socket, frames, send, barrier }
    }
    try {
      const first = await connect()
      const second = await connect()
      expect(connections).toHaveLength(2)
      expect(connections[0]!.id).not.toBe(connections[1]!.id)
      first.send("client.fixture", { from: "first" })
      second.send("client.fixture", { from: "second" })
      first.send("client.view.interests", {
        generation: 2,
        active: { scopeID: "home", sessionID: "current", generation: 5 },
        parts: [],
        details: [],
      })
      first.send("client.view.interests", {
        generation: 1,
        active: { scopeID: "home", sessionID: "old", generation: 1 },
        parts: [],
        details: [],
      })
      await Promise.all([first.barrier(), second.barrier()])
      expect(connections[0]!.received).toContainEqual({ type: "client.fixture", properties: { from: "first" } })
      expect(connections[0]!.received).not.toContainEqual({ type: "client.fixture", properties: { from: "second" } })
      expect(connections[0]!.active.at(-1)).toEqual({ scopeID: "home", sessionID: "current", generation: 5 })
      expect(connections[0]!.active).not.toContainEqual({ scopeID: "home", sessionID: "old", generation: 1 })
      expect(connections[0]!.send({ scopeID: "home", payload: { type: "server.fixture", properties: {} } })).toBe(true)
      await first.barrier()
      expect(first.frames.some((frame) => frame.payload.type === "server.fixture")).toBe(true)
      expect(second.frames.some((frame) => frame.payload.type === "server.fixture")).toBe(false)
      first.socket.close()
      await wait(() => connections[0]!.disposed === 1)
      expect(connections[0]!.send({ scopeID: null, payload: { type: "server.fixture", properties: {} } })).toBe(false)
      const replacement = await connect()
      expect(connections[2]!.id).not.toBe(connections[0]!.id)
      await replacement.barrier()
      await server.stop(true)
      expect(connections.map((connection) => connection.disposed)).toEqual([1, 1, 1])
    } finally {
      for (const socket of sockets) socket.close()
      await server.stop(true)
    }
  })
}, 20000)

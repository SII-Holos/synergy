import { expect, test } from "bun:test"
import { WSContext } from "hono/ws"
import { GlobalEventClients } from "../../src/server/global-event-clients"

type Connection = { context?: WSContext; drop: boolean }

test("a dropped terminal event closes the real socket and permits idle recovery on reconnect", async () => {
  const registry = GlobalEventClients.createRegistry()
  let status = "busy"
  const frame = () => JSON.stringify({ type: "session.status", properties: { status: { type: status } } })
  const connections = new Set<Bun.ServerWebSocket<Connection>>()
  const server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { drop: false } })) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        connections.add(socket)
        const context = new WSContext({
          raw: {
            get readyState() {
              return socket.readyState
            },
            send: (data: string) => (socket.data.drop ? 0 : socket.send(data)),
          },
          readyState: socket.readyState,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        })
        socket.data.context = context
        registry.add(context, "delta")
        registry.reply(context, frame())
      },
      message(socket, message) {
        if (message === "complete") {
          status = "idle"
          socket.data.drop = true
          registry.broadcast(frame)
        } else if (message === "ping") {
          registry.reply(socket.data.context!, "pong")
        }
      },
      close(socket) {
        connections.delete(socket)
        const context = socket.data.context
        socket.data.context = undefined
        if (context) registry.remove(context)
      },
    },
  })
  const sockets: WebSocket[] = []
  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
    sockets.push(socket)
    return socket
  }
  const nextMessage = (socket: WebSocket) =>
    new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true })
    })

  try {
    const first = connect()
    expect(JSON.parse(await nextMessage(first)).properties.status.type).toBe("busy")
    const closed = new Promise<CloseEvent>((resolve) => first.addEventListener("close", resolve, { once: true }))
    first.send("complete")
    expect((await closed).code).toBe(1013)
    expect(registry.size()).toBe(0)

    const recovered = connect()
    expect(JSON.parse(await nextMessage(recovered)).properties.status.type).toBe("idle")
    const pong = nextMessage(recovered)
    recovered.send("ping")
    expect(await pong).toBe("pong")
    expect(registry.size()).toBe(1)
  } finally {
    await Promise.all(
      sockets.map((socket) => {
        if (socket.readyState === WebSocket.CLOSED) return
        return new Promise<void>((resolve) => {
          socket.addEventListener("close", () => resolve(), { once: true })
          socket.close()
        })
      }),
    )
    registry.clear()
    for (const connection of connections) connection.terminate()
    server.stop(true)
  }
})

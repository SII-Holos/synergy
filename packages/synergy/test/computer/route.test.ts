import { expect, test } from "bun:test"
import { websocket } from "hono/bun"
import { ComputerBroker } from "../../src/computer/broker"
import { createComputerRoute } from "../../src/server/computer-route"

test("native registration and multiple replies share one host across WebSocket events", async () => {
  const token = "c".repeat(64)
  const broker = new ComputerBroker(token)
  const route = createComputerRoute(broker)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: route.fetch, websocket })
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/computer/host/broker`)
  const ready = Promise.withResolvers<void>()
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", version: 1, token })))
  socket.addEventListener("error", () => ready.reject(new Error("WebSocket failed")))
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.type === "registered") ready.resolve()
    else if (message.type === "command")
      socket.send(
        JSON.stringify({ type: "result", id: message.id, result: { output: "observed", images: [], metadata: {} } }),
      )
  })
  try {
    await ready.promise
    for (let i = 0; i < 2; i++) expect((await broker.execute("task", { type: "apps" })).output).toBe("observed")
  } finally {
    socket.close()
    await server.stop(true)
  }
}, 3000)

import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { testRuntime } from "../support/runtime"

test("capability negotiation, real multi-client projection and disconnect release agree", async () => {
  let leases = 0
  const runtime = await testRuntime(undefined, () =>
    Server.registerContributions({
      projections: [
        {
          kind: "fixture",
          eventType: "execution.updated",
          async open(interest, send, signal) {
            leases++
            let released = false,
              revision = 0
            const dispose = () => {
              if (released) return
              released = true
              leases--
            }
            signal?.addEventListener("abort", dispose, { once: true })
            const project = () =>
              send({
                scopeID: interest.scopeID,
                payload: {
                  type: "server.view.patch",
                  properties: {
                    kind: interest.kind,
                    sessionID: interest.sessionID,
                    generation: interest.generation,
                    revision: ++revision,
                    previousRevision: revision - 1,
                    patches: [{ path: ["status"], value: "running" }],
                  },
                },
              })
            project()
            return { project, dispose }
          },
        },
      ],
    }),
  )
  try {
    await runtime.run(async () => {
      const server = Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false })
      const sockets: WebSocket[] = []
      const wait = async (predicate: () => boolean) => {
        const limit = Date.now() + 5000
        while (!predicate()) {
          if (Date.now() > limit) throw new Error("projection did not settle")
          await Bun.sleep(5)
        }
      }
      try {
        const capabilities = await fetch(new URL("/global/capabilities", server.url)).then((r) => r.json())
        expect(capabilities.transports.projection).toBe("projection-v2")
        const connect = async () => {
          const url = new URL("/global/event/ws?stream=projection-v2", server.url)
          url.protocol = "ws:"
          const Socket = WebSocket as typeof WebSocket & {
            new (url: URL, options: { headers: Record<string, string> }): WebSocket
          }
          const socket = new Socket(url, { headers: { origin: server.url.origin } })
          sockets.push(socket)
          const frames: Array<{ payload: { type: string; properties: Record<string, unknown> } }> = []
          socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))
          await wait(() => frames.some((frame) => frame.payload.type === "server.connected"))
          return { socket, frames }
        }
        const a = await connect(),
          b = await connect()
        a.socket.send(
          JSON.stringify({
            payload: {
              type: "client.view.interests",
              properties: {
                generation: 1,
                parts: [],
                details: [{ kind: "fixture", scopeID: "home", sessionID: "session", generation: 1 }],
              },
            },
          }),
        )
        await wait(() => leases === 1)
        const feed = GlobalBus()
        for (let seq = 1; seq <= 30; seq++)
          feed.emit("event", {
            scopeID: "home",
            payload: {
              type: "execution.updated",
              epoch: "fixture",
              seq,
              properties: { sessionID: "session", context: "private-body".repeat(10000) },
            },
          })
        await wait(() => b.frames.filter((frame) => frame.payload.type === "server.cursor").length === 30)
        expect(b.frames.filter((frame) => frame.payload.type === "server.view.patch")).toHaveLength(0)
        expect(a.frames.filter((frame) => frame.payload.type === "server.view.patch")).toHaveLength(31)
        expect(JSON.stringify([...a.frames, ...b.frames])).not.toContain("private-body")
        expect([...a.frames, ...b.frames].every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 65536)).toBe(
          true,
        )
        a.socket.close()
        await wait(() => leases === 0)
        b.socket.send(JSON.stringify({ payload: { type: "client.ping", properties: {} } }))
        await wait(() => b.frames.some((frame) => frame.payload.type === "server.pong"))
      } finally {
        for (const socket of sockets) socket.close()
        await server.stop(true)
      }
    })
  } finally {
    await runtime.close()
  }
}, 20000)

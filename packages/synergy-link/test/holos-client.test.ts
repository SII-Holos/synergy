import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkHolosAuth } from "../src/holos/auth"
import { SynergyLinkHolosClient } from "../src/holos/client"
import type { SynergyLinkInboundHandler } from "../src/inbound/handler"

const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const inbound = {} as SynergyLinkInboundHandler

afterEach(() => {
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome
})

async function configureEndpoints(port: number) {
  process.env.SYNERGY_TEST_HOME = await mkdtemp(path.join(os.tmpdir(), "synergy-link-holos-client-test-"))
  const configPath = SynergyLinkHolosAuth.globalConfigPath()
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      holos: {
        apiUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        portalUrl: `http://127.0.0.1:${port}`,
      },
    }),
  )
}

describe("SynergyLinkHolosClient heartbeat liveness", () => {
  test("keeps the host connected while the gateway returns pong frames", async () => {
    let pingCount = 0
    const closed = Promise.withResolvers<string>()
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
    await configureEndpoints(server.port)
    const client = new SynergyLinkHolosClient(
      { agentID: "host-agent", agentSecret: "test-secret" },
      inbound,
      { onClose: ({ reason }) => closed.resolve(reason) },
      { intervalMs: 20, pongDeadlineMs: 80 },
    )

    try {
      await client.connect()
      await Bun.sleep(180)

      expect(pingCount).toBeGreaterThanOrEqual(4)
      expect(client.connected()).toBe(true)
      await expect(Promise.race([closed.promise, Bun.sleep(20).then(() => "still_connected")])).resolves.toBe(
        "still_connected",
      )
    } finally {
      await client.disconnect()
    }
  })

  test("closes a silent host tunnel with a liveness-loss reason", async () => {
    const closed = Promise.withResolvers<{ opened: boolean; intentional: boolean; reason: string }>()
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
    await configureEndpoints(server.port)
    const client = new SynergyLinkHolosClient(
      { agentID: "host-agent", agentSecret: "test-secret" },
      inbound,
      { onClose: (input) => closed.resolve(input) },
      { intervalMs: 20, pongDeadlineMs: 80 },
    )

    try {
      await client.connect()

      await expect(Promise.race([closed.promise, Bun.sleep(1_000).then(() => "timeout")])).resolves.toEqual({
        opened: true,
        intentional: false,
        reason: "transport_liveness_lost",
      })
      expect(client.connected()).toBe(false)
    } finally {
      await client.disconnect()
    }
  })
})

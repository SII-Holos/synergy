import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaProtocolBridge } from "@ericsanchezok/meta-protocol"
import { HolosLocalTakeover } from "../../src/holos/local-takeover"

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const originalMetaHome = process.env.META_SYNERGY_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const tempRoots: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  mock.restore()
  if (originalMetaHome === undefined) {
    delete process.env.META_SYNERGY_HOME
  } else {
    process.env.META_SYNERGY_HOME = originalMetaHome
  }
  if (originalSynergyHome === undefined) {
    delete process.env.SYNERGY_TEST_HOME
  } else {
    process.env.SYNERGY_TEST_HOME = originalSynergyHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("HolosProvider outbound parts", () => {
  test("replyMessage rejects non-text parts", async () => {
    const { HolosProvider } = await import("../../src/holos/runtime")
    const provider = new HolosProvider()
    ;(provider as any).send = mock(async () => ({ queued: false }))
    ;(provider as any).extractPeerFromMessageId = () => "peer_1"
    ;(provider as any).generateMessageId = () => "msg_1"

    await expect(
      provider.replyMessage({
        messageId: "peer:chat:reply",
        parts: [{ type: "image", path: "/tmp/example.png" }],
      }),
    ).rejects.toThrow("Holos replyMessage does not support outbound image parts yet")
  })
})

describe("Holos local meta proxy", () => {
  test("proxies meta execution requests to local meta-synergy and returns response envelope", async () => {
    const metaRoot = await createTempRoot("mp")
    process.env.META_SYNERGY_HOME = metaRoot

    const controlSocketPath = path.join(metaRoot, "control.sock")
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        const request = JSON.parse(line) as {
          action: string
          caller?: { agentID: string; ownerUserID: number }
          body?: { requestID?: string; tool?: string; action?: string }
        }
        if (request.action === "meta.execute") {
          expect(request.caller).toMatchObject({ agentID: "agent_remote", ownerUserID: 7 })
          expect(request.body).toMatchObject({ requestID: "req_1", tool: "session", action: "open" })
          socket.write(
            JSON.stringify({
              ok: true,
              payload: {
                version: 1,
                requestID: "req_1",
                ok: true,
                tool: "session",
                action: "open",
                result: {
                  title: "Session opened",
                  metadata: {
                    action: "open",
                    status: "opened",
                    sessionID: "sess_1",
                    remoteAgentID: "agent_remote",
                    remoteOwnerUserID: 7,
                    backend: "remote",
                  },
                  output: "opened",
                },
              },
            }) + "\n",
          )
          socket.end()
          return
        }
        socket.write(JSON.stringify({ ok: false, error: { code: "unknown", message: "unexpected" } }) + "\n")
        socket.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(controlSocketPath, resolve)
    })

    const { HolosProvider } = await import("../../src/holos/runtime")
    const provider = new HolosProvider()
    ;(provider as { send: typeof provider.send }).send = mock(async () => ({ queued: false }))

    try {
      await (
        provider as unknown as {
          handleLocalMetaExecution: (caller: unknown, payload: unknown) => Promise<void>
        }
      ).handleLocalMetaExecution(
        {
          type: "holos",
          agent_id: "agent_remote",
          owner_user_id: 7,
          profile: { name: "Remote" },
        },
        {
          version: 1,
          requestID: "req_1",
          envID: "env_test",
          tool: "session",
          action: "open",
          payload: { action: "open", label: "proxy" },
        },
      )

      expect(provider.send).toHaveBeenCalledTimes(1)
      expect(provider.send).toHaveBeenCalledWith(
        "agent_remote",
        MetaProtocolBridge.ResponseEvent,
        expect.objectContaining({
          version: 1,
          requestID: "req_1",
          ok: true,
          tool: "session",
          action: "open",
        }),
      )
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined))).catch(() => undefined)
    }
  })

  test("maps local control failures to meta execution error envelopes", async () => {
    const metaRoot = await createTempRoot("mpe")
    process.env.META_SYNERGY_HOME = metaRoot

    const controlSocketPath = path.join(metaRoot, "control.sock")
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        socket.write(
          JSON.stringify({
            ok: false,
            error: { code: "control_request_failed", message: "Invalid input for meta.execute" },
          }) + "\n",
        )
        socket.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(controlSocketPath, resolve)
    })

    const { HolosProvider } = await import("../../src/holos/runtime")
    const provider = new HolosProvider()
    ;(provider as { send: typeof provider.send }).send = mock(async () => ({ queued: false }))

    try {
      await (
        provider as unknown as {
          handleLocalMetaExecution: (caller: unknown, payload: unknown) => Promise<void>
        }
      ).handleLocalMetaExecution(
        {
          type: "holos",
          agent_id: "agent_remote",
          owner_user_id: 7,
        },
        {
          version: 1,
          requestID: "req_bad",
          envID: "env_test",
          tool: "session",
          action: "open",
          payload: { action: "open" },
        },
      )

      expect(provider.send).toHaveBeenCalledTimes(1)
      expect(provider.send).toHaveBeenCalledWith(
        "agent_remote",
        MetaProtocolBridge.ResponseEvent,
        expect.objectContaining({
          version: 1,
          requestID: "req_bad",
          ok: false,
          tool: "session",
          action: "open",
          error: expect.objectContaining({ code: "host_internal_error" }),
        }),
      )
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined))).catch(() => undefined)
    }
  })
})

describe("Holos local takeover", () => {
  test("claims local owner registry even when meta-synergy is absent", async () => {
    const root = await createTempRoot("meta")
    process.env.META_SYNERGY_HOME = root

    const result = await HolosLocalTakeover.takeover("agent_synergy")

    expect(result.metaDetected).toBe(false)
    expect(result.handoff).toBe("none")

    const owner = await Bun.file(path.join(root, "owner.json")).json()
    expect(owner).toMatchObject({
      owner: "synergy",
      agentId: "agent_synergy",
      version: 1,
    })
  })

  test("connect performs Phase 1 takeover and stops old local meta-synergy fallback", async () => {
    const metaRoot = await createTempRoot("meta")
    const synergyHome = await createTempRoot("synergy")
    process.env.META_SYNERGY_HOME = metaRoot
    process.env.SYNERGY_TEST_HOME = synergyHome
    await Bun.write(path.join(metaRoot, "owner.json"), JSON.stringify({ owner: "meta-synergy" }) + "\n")

    mock.module("../../src/provider/api-key", () => ({
      Auth: {
        get: mock(async () => ({ type: "holos", agentId: "agent_test", agentSecret: "secret_test" })),
      },
    }))

    let stopRequested = false
    const controlSocketPath = path.join(metaRoot, "control.sock")
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        const request = JSON.parse(line) as { action: string }
        if (request.action === "ping") {
          socket.write(JSON.stringify({ ok: true, payload: null }) + "\n")
          socket.end()
          return
        }
        if (request.action === "runtime.enter_managed_mode" || request.action === "runtime.set_mode") {
          socket.write(
            JSON.stringify({
              ok: false,
              error: { code: "control_request_failed", message: "Unsupported control action" },
            }) + "\n",
          )
          socket.end()
          return
        }
        if (request.action === "service.stop") {
          stopRequested = true
          socket.write(JSON.stringify({ ok: true, payload: null }) + "\n")
          socket.end()
          queueMicrotask(() => {
            server.close()
          })
          return
        }
        socket.write(JSON.stringify({ ok: false, error: { code: "unknown", message: "unexpected" } }) + "\n")
        socket.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(controlSocketPath, resolve)
    })

    const fetchMock = mock(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes("ws_token")) {
        return new Response(JSON.stringify({ code: 0, data: { ws_token: "token_1", expires_in: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected fetch: ${href}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const sockets: FakeWebSocket[] = []
    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readonly url: string
      readyState = FakeWebSocket.CONNECTING

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        sockets.push(this)
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN
          this.dispatchEvent(new Event("open"))
        })
      }

      send() {}

      close() {
        this.readyState = FakeWebSocket.CLOSED
        this.dispatchEvent(new Event("close"))
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const { HolosProvider } = await import("../../src/holos/runtime")
    const provider = new HolosProvider()
    const abort = new AbortController()

    try {
      await provider.connect({
        config: {
          enabled: true,
          apiUrl: "https://api.example.test",
          wsUrl: "wss://ws.example.test",
          portalUrl: "https://portal.example.test",
        },
        signal: abort.signal,
      })

      expect(stopRequested).toBe(true)
      expect(sockets).toHaveLength(1)
      expect(sockets[0]?.url).toContain("token=token_1")

      const owner = await Bun.file(path.join(metaRoot, "owner.json")).json()
      expect(owner).toMatchObject({
        owner: "synergy",
        agentId: "agent_test",
        version: 1,
      })
    } finally {
      abort.abort()
      await new Promise((resolve) => server.close(() => resolve(undefined))).catch(() => undefined)
    }
  })
})

async function createTempRoot(prefix: string): Promise<string> {
  const root = path.join(os.tmpdir(), `sy-${prefix}-${Math.random().toString(36).slice(2, 8)}`)
  tempRoots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

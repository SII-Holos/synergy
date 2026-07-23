import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Global } from "../../src/global"
import { HolosAccounts } from "../../src/holos/accounts"
import { HolosRuntime } from "../../src/holos/runtime"
import { NATIVE_FRAME_SIZE_LIMIT, NATIVE_MAX_PAYLOAD_BYTES } from "../../src/holos/native"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

const originalConfigCurrent = ConfigRuntime.current
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

class TestWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: TestWebSocket[] = []

  readyState = TestWebSocket.OPEN
  readonly sent: string[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor() {
    TestWebSocket.instances.push(this)
    queueMicrotask(() => this.emit("open", {}))
  }

  addEventListener(event: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === TestWebSocket.CLOSED) return
    this.readyState = TestWebSocket.CLOSED
    this.emit("close", {})
  }

  receive(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) })
  }

  private emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

function inHome<T>(fn: () => T | Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

async function waitForConnected() {
  const timeoutAt = Date.now() + 2_000
  let status = await HolosRuntime.status()
  while (status.status !== "connected" && Date.now() < timeoutAt) {
    await Bun.sleep(5)
    status = await HolosRuntime.status()
  }
  if (status.status !== "connected") throw new Error(`Timed out waiting for Holos connection: ${status.status}`)
}

afterEach(async () => {
  await inHome(() => HolosRuntime.stop()).catch(() => {})
  ConfigRuntime.current = originalConfigCurrent
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  TestWebSocket.instances = []
  await fs.rm(Global.Path.authHolosAccounts, { force: true }).catch(() => {})
})

async function waitForSocketWrite(socket: TestWebSocket) {
  const timeoutAt = Date.now() + 2_000
  while (socket.sent.length === 0 && Date.now() < timeoutAt) await Bun.sleep(5)
  if (socket.sent.length === 0) throw new Error("Timed out waiting for Holos socket write")
}

async function startRuntime() {
  await HolosAccounts.saveAndActivateAccount("agent-wire", "secret-wire")
  ConfigRuntime.current = mock(async () => {
    return {
      holos: {
        enabled: true,
        apiUrl: "https://holos.test",
        wsUrl: "wss://holos.test",
        portalUrl: "https://holos.test",
      },
    } as Config.Info
  }) as typeof ConfigRuntime.current
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify({ code: 0, data: { ws_token: "token-wire", expires_in: 60 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket

  await inHome(() => HolosRuntime.init())
  await waitForConnected()

  const socket = TestWebSocket.instances.at(-1)
  if (!socket) throw new Error("Holos WebSocket was not created")
  return { socket, tunnel: await HolosRuntime.getNativeTunnel() }
}

describe.serial("Holos native top-level wire protocol", () => {
  test("writes the requested clarus.* type directly and correlates its top-level response", async () => {
    const { socket, tunnel } = await startRuntime()
    const observed: string[] = []
    tunnel.registerNativeObserver((message) => {
      observed.push(message.type)
    })

    const request = tunnel.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: { project_id: "project-wire" },
      requestID: "request-wire",
      expectedResponseType: "clarus.project.subscribed",
      timeoutMs: 1_000,
      meta: { schema_version: "1.0" },
    })
    void request.response.catch(() => {})

    await waitForSocketWrite(socket)
    const outbound = JSON.parse(socket.sent.at(-1) ?? "null")
    expect(outbound).toEqual({
      type: "clarus.project.subscribe",
      request_id: "request-wire",
      meta: { schema_version: "1.0" },
      payload: { project_id: "project-wire" },
      caller: null,
    })

    socket.receive({
      type: "clarus.project.subscribed",
      request_id: "request-wire",
      meta: { schema_version: "1.0" },
      payload: { project_id: "project-wire", subscribed: true },
      caller: { type: "agent", id: "agent-wire", name: "Agent Wire" },
    })

    await expect(request.response).resolves.toMatchObject({
      type: "clarus.project.subscribed",
      requestID: "request-wire",
      payload: { project_id: "project-wire", subscribed: true },
      agentID: "agent-wire",
      generation: 1,
      caller: { type: "agent", id: "agent-wire", name: "Agent Wire" },
    })
    const timeoutAt = Date.now() + 2_000
    while (observed.length === 0 && Date.now() < timeoutAt) await Bun.sleep(5)
    expect(observed).toEqual(["clarus.project.subscribed"])
  })

  test("rejects an oversized fully serialized native frame before writing to the socket", async () => {
    const { socket, tunnel } = await startRuntime()
    const type = "clarus.project.subscribe"
    const requestID = "request-oversized-frame"
    const payload = null
    const emptyMeta = { padding: "" }
    const baseWireFrame = JSON.stringify({
      type,
      request_id: requestID,
      meta: emptyMeta,
      payload,
      caller: null,
    })
    const padding = "x".repeat(NATIVE_FRAME_SIZE_LIMIT - baseWireFrame.length + 1)
    const meta = { padding }

    expect(JSON.stringify({ type, payload, requestID, meta }).length).toBeLessThanOrEqual(NATIVE_FRAME_SIZE_LIMIT)
    expect(JSON.stringify({ type, request_id: requestID, meta, payload, caller: null }).length).toBeGreaterThan(
      NATIVE_FRAME_SIZE_LIMIT,
    )

    const request = tunnel.sendNativeRequest({
      type,
      payload,
      requestID,
      expectedResponseType: "clarus.project.subscribed",
      timeoutMs: 50,
      meta,
    })

    await expect(request.response).rejects.toEqual({
      disposition: "rejected",
      requestID,
      code: "FRAME_TOO_LARGE",
      message: `Frame exceeds ${NATIVE_FRAME_SIZE_LIMIT} bytes`,
    })
    expect(socket.sent.some((frame) => JSON.parse(frame).request_id === requestID)).toBe(false)
  })
  test("measures native payload and frame limits in UTF-8 bytes", async () => {
    const { socket, tunnel } = await startRuntime()
    const payloadRequestID = "request-oversized-utf8-payload"
    const payload = { data: "界".repeat(Math.ceil(NATIVE_MAX_PAYLOAD_BYTES / 3)) }
    const serializedPayload = JSON.stringify(payload)
    expect(serializedPayload.length).toBeLessThanOrEqual(NATIVE_MAX_PAYLOAD_BYTES)
    expect(new TextEncoder().encode(serializedPayload).byteLength).toBeGreaterThan(NATIVE_MAX_PAYLOAD_BYTES)

    const payloadRequest = tunnel.sendNativeRequest({
      type: "clarus.runtime.task.result",
      payload,
      requestID: payloadRequestID,
      expectedResponseType: "clarus.runtime.task.result.recorded",
      timeoutMs: 50,
    })
    await expect(payloadRequest.response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: payloadRequestID,
      code: "PAYLOAD_TOO_LARGE",
    })

    const frameRequestID = "request-oversized-utf8-frame"
    const type = "clarus.project.subscribe"
    const emptyMeta = { padding: "" }
    const baseFrame = JSON.stringify({
      type,
      request_id: frameRequestID,
      meta: emptyMeta,
      payload: null,
      caller: null,
    })
    const baseFrameBytes = new TextEncoder().encode(baseFrame).byteLength
    const meta = { padding: "界".repeat(Math.ceil((NATIVE_FRAME_SIZE_LIMIT - baseFrameBytes + 1) / 3)) }
    const frame = JSON.stringify({ type, request_id: frameRequestID, meta, payload: null, caller: null })
    expect(frame.length).toBeLessThanOrEqual(NATIVE_FRAME_SIZE_LIMIT)
    expect(new TextEncoder().encode(frame).byteLength).toBeGreaterThan(NATIVE_FRAME_SIZE_LIMIT)

    const frameRequest = tunnel.sendNativeRequest({
      type,
      payload: null,
      requestID: frameRequestID,
      expectedResponseType: "clarus.project.subscribed",
      timeoutMs: 50,
      meta,
    })
    await expect(frameRequest.response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: frameRequestID,
      code: "FRAME_TOO_LARGE",
    })

    expect(socket.sent.some((wire) => [payloadRequestID, frameRequestID].includes(JSON.parse(wire).request_id))).toBe(
      false,
    )
  })

  test("settles a correlated gateway error as an authoritative rejection", async () => {
    const { socket, tunnel } = await startRuntime()
    const request = tunnel.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: { project_id: "project-wire" },
      requestID: "request-error",
      expectedResponseType: "clarus.project.subscribed",
      timeoutMs: 1_000,
    })
    void request.response.catch(() => {})
    await waitForSocketWrite(socket)

    socket.receive({
      type: "error",
      request_id: "request-error",
      meta: { schema_version: "1.0", module: "clarus" },
      payload: { code: "PROJECT_NOT_FOUND", message: "Project is not visible" },
      caller: null,
    })

    await expect(request.response).rejects.toEqual({
      disposition: "rejected",
      requestID: "request-error",
      code: "PROJECT_NOT_FOUND",
      message: "Project is not visible",
    })
  })
  test("continues native observer delivery when an earlier observer throws", async () => {
    const { socket, tunnel } = await startRuntime()
    const received: string[] = []
    tunnel.registerNativeObserver(() => {
      throw new Error("expected native observer failure")
    })
    tunnel.registerNativeObserver(async () => {
      throw new Error("expected async native observer failure")
    })
    tunnel.registerNativeObserver((message) => {
      received.push(message.type)
    })

    socket.receive({
      type: "clarus.runtime.task.assigned",
      request_id: null,
      meta: { schema_version: "1.0" },
      payload: { task_id: "task-wire" },
      caller: { type: "system", id: "clarus-runtime", name: "Clarus Runtime" },
    })

    const timeoutAt = Date.now() + 2_000
    while (received.length === 0 && Date.now() < timeoutAt) await Bun.sleep(5)
    expect(received).toEqual(["clarus.runtime.task.assigned"])
  })

  test("drops a malformed chat caller without blocking later native frames", async () => {
    const { socket, tunnel } = await startRuntime()
    const received: string[] = []
    tunnel.registerNativeObserver((message) => {
      received.push(message.type)
    })

    expect(() =>
      socket.receive({
        type: "ws_send",
        request_id: "request-malformed-caller",
        meta: { event: "chat.message" },
        payload: { text: "ignored", messageId: "message-malformed-caller" },
        caller: { type: "agent", id: "not-a-chat-caller" },
      }),
    ).not.toThrow()

    socket.receive({
      type: "clarus.runtime.task.assigned",
      request_id: null,
      meta: { schema_version: "1.0" },
      payload: { task_id: "task-after-malformed-caller" },
      caller: { type: "system", id: "clarus-runtime", name: "Clarus Runtime" },
    })

    const timeoutAt = Date.now() + 2_000
    while (received.length === 0 && Date.now() < timeoutAt) await Bun.sleep(5)
    expect(received).toEqual(["clarus.runtime.task.assigned"])
    await expect(HolosRuntime.status()).resolves.toMatchObject({ status: "connected" })
  })

  test("continues connection observer delivery when an earlier observer throws", async () => {
    const { tunnel } = await startRuntime()
    const received: string[] = []
    tunnel.registerConnectionObserver(() => {
      throw new Error("expected connection observer failure")
    })
    tunnel.registerConnectionObserver(async () => {
      throw new Error("expected async connection observer failure")
    })
    tunnel.registerConnectionObserver((event) => {
      received.push(event.type)
    })

    await expect(inHome(() => HolosRuntime.stop())).resolves.toBeUndefined()
    expect(received).toEqual(["disconnected"])
  })
})

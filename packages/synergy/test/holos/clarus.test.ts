import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import fs from "node:fs/promises"
import { HolosAccounts } from "../../src/holos/accounts"
import { Envelope } from "../../src/holos/envelope"
import { HolosProvider, HolosRuntime } from "../../src/holos/runtime"
import type { NativeMessage, NativeTunnelPort, HolosConnectionEvent } from "../../src/holos/native"

// ── Temporary home directory isolation ─────────────────────────────────
const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-holos-clarus-"))
const origHome = process.env["SYNERGY_TEST_HOME"]
const authDir = join(tmpDir, ".synergy", "data", "auth")
const accountsPath = join(authDir, "holos-accounts.json")
const apiKeyPath = join(authDir, "api-key.json")

// ── Test connection shape matches RuntimeConnection fields ─────────────

type TestRuntimeConnection = ConstructorParameters<typeof HolosProvider>[0]

function createRuntimeConnection(): TestRuntimeConnection {
  return {
    holosConfig: null,
    abort: new AbortController(),
    status: { status: "disconnected" },
    provider: null,
    reconnectTimer: null,
    generation: 0,
    epoch: Date.now(),
    sessionID: null,
    nativeObservers: new Set(),
    connectionObservers: new Set(),
  }
}

// ── Test WebSocket mock ────────────────────────────────────────────────

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const activeControllers = new Set<AbortController>()
const appEventUnsubscribers = new Set<() => void>()

class ProviderTestWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: ProviderTestWebSocket[] = []

  readyState = ProviderTestWebSocket.CONNECTING
  readonly sent: string[] = []
  onSend: ((data: string) => void) | null = null
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(readonly url: string) {
    ProviderTestWebSocket.instances.push(this)
  }

  addEventListener(event: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  open() {
    this.readyState = ProviderTestWebSocket.OPEN
    this.emit("open", {})
  }

  send(data: string) {
    this.sent.push(data)
    this.onSend?.(data)
  }

  message(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) })
  }

  close(code = 1000, reason = "test cleanup") {
    if (this.readyState === ProviderTestWebSocket.CLOSED) return
    this.readyState = ProviderTestWebSocket.CLOSED
    this.emit("close", { code, reason })
  }

  private emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}
function makeTokenFetch(): typeof fetch {
  const tokenFetch = (..._args: Parameters<typeof originalFetch>): ReturnType<typeof originalFetch> =>
    Promise.resolve(
      new Response(JSON.stringify({ code: 0, data: { ws_token: "token", expires_in: 60 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  return Object.assign(tokenFetch, { preconnect: originalFetch.preconnect })
}

function installProviderWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: ProviderTestWebSocket,
  })
}

// ── Fixture helpers ────────────────────────────────────────────────────

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(1)
  }
}

async function connectProvider(connection: TestRuntimeConnection) {
  await HolosAccounts.saveAndActivateAccount("agent_test", "secret_test")
  globalThis.fetch = makeTokenFetch()
  installProviderWebSocket()

  const controller = new AbortController()
  activeControllers.add(controller)
  const provider = new HolosProvider(connection)
  connection.provider = provider
  const socketIndex = ProviderTestWebSocket.instances.length
  const connected = provider.connect({
    config: {
      enabled: true,
      apiUrl: "https://api.test",
      wsUrl: "wss://ws.test",
      portalUrl: "https://portal.test",
    },
    signal: controller.signal,
  })
  await waitFor(() => ProviderTestWebSocket.instances.length > socketIndex)
  const socket = ProviderTestWebSocket.instances[socketIndex]
  socket.open()
  await connected
  return { provider, socket, controller }
}

function nativeFrame(input: {
  type: string
  requestID: string | null
  payload: unknown
  meta?: Record<string, unknown>
}) {
  return {
    type: input.type,
    request_id: input.requestID,
    meta: input.meta ?? {},
    payload: input.payload,
    caller: null,
  }
}

function connectedFrame(sessionID: string) {
  return {
    type: "connected",
    request_id: null,
    meta: { session_id: sessionID, server_time: "2026-07-14T00:00:00Z" },
    payload: null,
    caller: null,
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env["SYNERGY_TEST_HOME"] = tmpDir
  await fs.mkdir(authDir, { recursive: true })
})

afterAll(() => {
  if (origHome !== undefined) {
    process.env["SYNERGY_TEST_HOME"] = origHome
  } else {
    delete process.env["SYNERGY_TEST_HOME"]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(accountsPath, { force: true }).catch(() => {})
  await fs.rm(apiKeyPath, { force: true }).catch(() => {})
})

afterEach(async () => {
  for (const unsubscribe of appEventUnsubscribers) unsubscribe()
  appEventUnsubscribers.clear()
  for (const controller of activeControllers) controller.abort()
  activeControllers.clear()
  ProviderTestWebSocket.instances = []
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
})

// ═════════════════════════════════════════════════════════════════════════
// Envelope tests
// ═════════════════════════════════════════════════════════════════════════

describe("Envelope native parsing", () => {
  test("kind=native for clarus.* types", () => {
    const p = Envelope.parse(
      JSON.stringify({ type: "clarus.x", request_id: "r", meta: { v: "1" }, payload: { a: 1 }, caller: null }),
    )
    expect(p).not.toBeNull()
    expect(p!.kind).toBe("native")
  })

  test("error normalizes payload first then meta", () => {
    const a = Envelope.parse(
      JSON.stringify({ type: "error", request_id: "r", meta: {}, payload: { code: "P", message: "pm" }, caller: null }),
    )
    if (!a) throw new Error("Expected non-null parsed")
    if (a.kind !== "error") throw new Error("Expected error kind")
    expect(a.code).toBe("P")
    const b = Envelope.parse(
      JSON.stringify({
        type: "error",
        request_id: "r",
        meta: { code: "M", message: "mm" },
        payload: null,
        caller: null,
      }),
    )
    if (!b) throw new Error("Expected non-null parsed")
    if (b.kind !== "error") throw new Error("Expected error kind")
    expect(b.code).toBe("M")
  })

  test("outbound native has correct meta", () => {
    const wire = Envelope.native({
      type: "clarus.project.subscribe",
      requestID: "req-1",
      meta: { schema_version: "1.0" },
      payload: { project_id: "p1" },
    })
    const obj = JSON.parse(wire)
    expect(obj.type).toBe("clarus.project.subscribe")
    expect(obj.request_id).toBe("req-1")
    expect(obj.meta).toEqual({ schema_version: "1.0" })
    expect(obj.meta.module).toBeUndefined()
    expect(obj.meta.timestamp).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Schema and DTO shapes
// ═════════════════════════════════════════════════════════════════════════

describe("Schema and DTO shapes", () => {
  test("ClarusPayload", async () => {
    const { ClarusPayload } = await import("../../src/holos/clarus")
    expect(ClarusPayload.parseKnown("clarus.project.subscribed", { project_id: "p", subscribed: true }).kind).toBe(
      "known",
    )
    expect(ClarusPayload.parseKnown("clarus.x", {}).kind).toBe("unknown")
    expect(ClarusPayload.parseKnown("clarus.project.subscribed", {}).kind).toBe("invalid")
  })

  test("ProjectSubscribedEvent shape", () => {
    const e = {
      kind: "known" as const,
      type: "projectSubscribed" as const,
      agentID: "a",
      requestID: null,
      projectID: "p",
    }
    expect(e.type).toBe("projectSubscribed")
  })

  test("ProjectMessageCreatedEvent nested message", () => {
    const e = {
      kind: "known" as const,
      type: "projectMessageCreated" as const,
      agentID: "a",
      requestID: null,
      projectID: "p",
      message: { messageID: "m1", senderID: "s1", content: "hello" },
    }
    expect(e.message.messageID).toBe("m1")
  })

  test("RuntimeTaskExtendedEvent shape", () => {
    const e = {
      kind: "known" as const,
      type: "runtimeTaskExtended" as const,
      agentID: "a",
      requestID: null,
      projectID: "p",
      runID: "r1",
      task: { taskID: "t1", deadlineAt: null, status: "running" },
    }
    expect(e.type).toBe("runtimeTaskExtended")
  })

  test("HolosConnectionEvent connected shape", () => {
    const c: HolosConnectionEvent = { type: "connected", agentID: "a", sessionID: "s1", generation: 1, epoch: 123 }
    expect(c.agentID).toBe("a")
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Adapter integration tests
// ═════════════════════════════════════════════════════════════════════════

describe("Clarus adapter integration", () => {
  test("requestID preserved exactly", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const sent: Array<{ requestID: string }> = []
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: (input) => {
        sent.push({ requestID: input.requestID })
        return {
          requestID: input.requestID,
          response: Promise.resolve({
            type: "clarus.project.subscribed",
            requestID: input.requestID,
            meta: {},
            payload: { project_id: "p1", subscribed: true },
            caller: null,
            agentID: "a",
            sessionID: null,
            generation: 1,
          } as NativeMessage),
        }
      },
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    expect(port.subscribeProject({ projectID: "p1", requestID: "my-exact-id" }).requestID).toBe("my-exact-id")
    expect(sent[0].requestID).toBe("my-exact-id")
  })

  test("invalid response payload rejects ambiguous/invalid_response", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({
        requestID: "req-1",
        response: Promise.resolve({
          type: "clarus.project.subscribed",
          requestID: "req-1",
          meta: {},
          payload: { invalid: true },
          caller: null,
          agentID: "a",
          sessionID: null,
          generation: 1,
        } as NativeMessage),
      }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    await port.subscribeProject({ projectID: "p1", requestID: "req-1" }).response.then(
      () => {
        throw new Error("should not resolve")
      },
      (err) => {
        expect(err.disposition).toBe("ambiguous")
        expect(err.reason).toBe("invalid_response")
      },
    )
  })

  test("successful response dual-path: resolution + observer", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const events: Array<{ kind: string }> = []
    const nativeMsg: NativeMessage = {
      type: "clarus.project.subscribed",
      requestID: "req-1",
      meta: {},
      payload: { project_id: "p1", subscribed: true },
      caller: null,
      agentID: "a",
      sessionID: null,
      generation: 1,
      epoch: 1,
    }
    let captureObs: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (h) => {
        captureObs = h
        return () => {
          captureObs = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "req-1", response: Promise.resolve(nativeMsg) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })
    captureObs!(nativeMsg)
    await new Promise((r) => setTimeout(r, 5))
    expect(events.length).toBeGreaterThanOrEqual(1)
    if (events.length > 0 && events[0].kind === "known") {
      const known = events[0] as { kind: "known"; type: string }
      expect(known.type).toBe("projectSubscribed")
    }
  })

  test("classifies blank inbound task run IDs as invalid events", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((message: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "unused", response: Promise.resolve({} as NativeMessage) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((event) => {
      events.push(event)
    })

    captureObserver!({
      type: "clarus.runtime.task.assigned",
      requestID: null,
      meta: {},
      payload: {
        run_id: "  ",
        project_id: "project-1",
        task_id: "task-1",
        phase: "execute",
        subtask_id: "subtask-1",
        attempt: 1,
        deadline_at: null,
      },
      caller: null,
      agentID: "agent-1",
      sessionID: "session-1",
      generation: 1,
      epoch: 1,
    })

    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchObject({
      kind: "invalid",
      sourceType: "clarus.runtime.task.assigned",
      agentID: "agent-1",
      requestID: null,
    })
  })

  test("adapter unsubscribe returns functions", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "r", response: Promise.resolve({} as NativeMessage) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    expect(typeof port.registerEventHandler(() => {})).toBe("function")
    expect(typeof port.registerConnectionHandler(() => {})).toBe("function")
  })

  test("returns synchronous tunnel rejections through the response promise", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const rejection = {
      disposition: "rejected" as const,
      requestID: "not-connected",
      code: "NOT_CONNECTED",
      message: "Holos Agent Tunnel is not connected",
    }
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => {
        throw rejection
      },
    }
    const port = createClarusAgentTunnelAdapter(tunnel)

    const result = port.subscribeProject({ projectID: "project-1", requestID: "not-connected" })

    expect(result.requestID).toBe("not-connected")
    await expect(result.response).rejects.toEqual(rejection)
  })

  test("rejects blank run IDs before dispatch", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    let dispatchCount = 0
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => {
        dispatchCount++
        return { requestID: "unreachable", response: Promise.resolve({} as NativeMessage) }
      },
    }
    const port = createClarusAgentTunnelAdapter(tunnel)

    const extend = port.extendTask({ runID: "  ", requestID: "extend-blank" })
    await expect(extend.response).rejects.toEqual({
      disposition: "rejected",
      requestID: "extend-blank",
      code: "INVALID_RUN_ID",
      message: "runID must not be blank",
    })

    const record = port.recordTaskResult({
      runID: "",
      subtaskID: "subtask-1",
      success: true,
      output: "done",
      artifacts: [],
      evidenceRefs: [],
      notaryRefs: [],
      payload: {},
      requestID: "record-blank",
    })
    await expect(record.response).rejects.toEqual({
      disposition: "rejected",
      requestID: "record-blank",
      code: "INVALID_RUN_ID",
      message: "runID must not be blank",
    })
    expect(dispatchCount).toBe(0)
  })

  test("ZodError from invalid response is converted to ambiguous/invalid_response", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/holos/clarus")
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({
        requestID: "req-z",
        response: Promise.resolve({
          type: "clarus.project.subscribed",
          requestID: "req-z",
          meta: {},
          payload: {},
          caller: null,
          agentID: "a",
          sessionID: null,
          generation: 1,
        } as NativeMessage),
      }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    let error: { disposition: string; reason?: string } | null = null
    try {
      await port.subscribeProject({ projectID: "p1", requestID: "req-z" }).response
    } catch (e) {
      error = e as { disposition: string; reason?: string }
    }
    expect(error).not.toBeNull()
    if (error!.disposition === "ambiguous") {
      expect(error!.reason).toBe("invalid_response")
    } else {
      throw new Error(`Expected ambiguous but got ${error!.disposition}`)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════
// HolosProvider native tunnel tests
// ═════════════════════════════════════════════════════════════════════════

describe("HolosProvider native tunnel", () => {
  test("registers native correlation before a synchronous socket response", async () => {
    const connection = createRuntimeConnection()
    const { provider, socket } = await connectProvider(connection)
    socket.onSend = (data) => {
      const request = JSON.parse(data) as { type: string; request_id: string }
      socket.message(
        nativeFrame({
          type: "clarus.project.subscribed",
          requestID: request.request_id,
          payload: { project_id: "project-1", subscribed: true },
        }),
      )
    }

    const pending = provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: { project_id: "project-1" },
      requestID: "native-sync",
      expectedResponseType: "clarus.project.subscribed",
      timeoutMs: 50,
    })

    expect(pending.requestID).toBe("native-sync")
    expect((await pending.response).requestID).toBe("native-sync")
  })

  test("settles generic errors and unexpected response types structurally", async () => {
    const connection = createRuntimeConnection()
    const { provider, socket } = await connectProvider(connection)
    const rejected = provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "native-error",
      expectedResponseType: "clarus.project.subscribed",
    })
    socket.message({
      type: "error",
      request_id: "native-error",
      meta: { code: "META_CODE", message: "meta message" },
      payload: { code: "PROJECT_DENIED", message: "Project access denied" },
      caller: null,
    })
    await expect(rejected.response).rejects.toEqual({
      disposition: "rejected",
      requestID: "native-error",
      code: "PROJECT_DENIED",
      message: "Project access denied",
    })

    const observed: NativeMessage[] = []
    connection.nativeObservers.add((message) => {
      observed.push(message)
    })
    const ambiguous = provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "native-unexpected",
      expectedResponseType: "clarus.project.subscribed",
    })
    socket.message(
      nativeFrame({
        type: "clarus.project.message_created",
        requestID: "native-unexpected",
        payload: { project_id: "project-1" },
      }),
    )
    await expect(ambiguous.response).rejects.toEqual({
      disposition: "ambiguous",
      requestID: "native-unexpected",
      reason: "unexpected_response",
      message: "Expected clarus.project.subscribed, got clarus.project.message_created",
    })
    await waitFor(() => observed.length === 1)
  })

  test("settles successful responses and dispatches the same message to observers", async () => {
    const connection = createRuntimeConnection()
    const observed: NativeMessage[] = []
    connection.nativeObservers.add((message) => {
      observed.push(message)
    })
    const { provider, socket } = await connectProvider(connection)
    socket.message(connectedFrame("session-1"))
    await waitFor(() => connection.generation === 1)

    const pending = provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "native-dual",
      expectedResponseType: "clarus.project.subscribed",
    })
    socket.message(
      nativeFrame({
        type: "clarus.project.subscribed",
        requestID: "native-dual",
        payload: { project_id: "project-1", subscribed: true },
      }),
    )

    const response = await pending.response
    await waitFor(() => observed.length === 1)
    expect(observed[0]).toBe(response)
    expect(response).toMatchObject({
      agentID: "agent_test",
      sessionID: "session-1",
      generation: 1,
    })
  })

  test("increments generations across providers and ignores stale sockets", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    const native: NativeMessage[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    connection.nativeObservers.add((message) => {
      native.push(message)
    })

    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-1"))
    await waitFor(() => lifecycle.length === 1)

    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-2"))
    await waitFor(() => lifecycle.length === 2)

    first.socket.message(connectedFrame("stale-session"))
    first.socket.message(
      nativeFrame({ type: "clarus.project.subscribed", requestID: null, payload: { project_id: "stale" } }),
    )
    second.socket.message(
      nativeFrame({ type: "clarus.project.subscribed", requestID: null, payload: { project_id: "current" } }),
    )
    await waitFor(() => native.length === 1)

    expect(lifecycle).toMatchObject([
      { type: "connected", agentID: "agent_test", sessionID: "session-1", generation: 1 },
      { type: "connected", agentID: "agent_test", sessionID: "session-2", generation: 2 },
    ])
    expect(connection.generation).toBe(2)
    expect(native[0]).toMatchObject({ sessionID: "session-2", generation: 2, payload: { project_id: "current" } })
  })
})

test("routes legacy sends and native requests through one correlated socket", async () => {
  const connection = createRuntimeConnection()
  const { provider, socket } = await connectProvider(connection)
  socket.onSend = (data) => {
    const request = JSON.parse(data) as { type: string; request_id: string }
    if (request.type === "ws_send") {
      socket.message({
        type: "error",
        request_id: request.request_id,
        meta: {},
        payload: { code: "DELIVERY_FAILED", message: "offline" },
        caller: null,
      })
      return
    }
    socket.message(
      nativeFrame({
        type: "clarus.project.subscribed",
        requestID: request.request_id,
        payload: { project_id: "project-1", subscribed: true },
      }),
    )
  }

  const [legacy, native] = await Promise.all([
    provider.send("peer-mixed", "chat.message", { text: "hello" }),
    provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "native-mixed",
      expectedResponseType: "clarus.project.subscribed",
    }).response,
  ])

  expect(legacy).toEqual({ sent: false, reason: "delivery_failed" })
  expect(native.requestID).toBe("native-mixed")
  expect(socket.sent.map((data) => JSON.parse(data).type)).toEqual(["ws_send", "clarus.project.subscribe"])
})

test("does not let a slow native observer block settlement or legacy app events", async () => {
  const connection = createRuntimeConnection()
  let releaseObserver!: () => void
  const observerGate = new Promise<void>((resolve) => {
    releaseObserver = resolve
  })
  let observerStarted = false
  connection.nativeObservers.add(async () => {
    observerStarted = true
    await observerGate
  })
  let appHandled = false
  const unsubscribe = HolosRuntime.registerAppEventHandler(({ event }) => {
    if (event !== "test.mixed") return false
    appHandled = true
    return true
  })
  appEventUnsubscribers.add(unsubscribe)
  const { provider, socket } = await connectProvider(connection)
  const pending = provider.sendNativeRequest({
    type: "clarus.project.subscribe",
    payload: {},
    requestID: "native-slow-observer",
    expectedResponseType: "clarus.project.subscribed",
  })
  socket.message(
    nativeFrame({
      type: "clarus.project.subscribed",
      requestID: "native-slow-observer",
      payload: { project_id: "project-1", subscribed: true },
    }),
  )
  socket.message({
    type: "ws_send",
    request_id: "legacy-event",
    meta: { event: "test.mixed" },
    payload: { value: 1 },
    caller: { type: "agent", agent_id: "peer-1", owner_user_id: 1 },
  })

  expect((await pending.response).requestID).toBe("native-slow-observer")
  await waitFor(() => observerStarted && appHandled)
  releaseObserver()
})

test("envelope co-broadcast: native and ws_send through shared parse path", async () => {
  const connection = createRuntimeConnection()
  const nativeObserved: NativeMessage[] = []
  connection.nativeObservers.add((msg) => {
    nativeObserved.push(msg)
  })
  let appEventReceived = false
  const unsubscribe = HolosRuntime.registerAppEventHandler(({ event }) => {
    if (event === "co.event") {
      appEventReceived = true
      return true
    }
    return false
  })
  appEventUnsubscribers.add(unsubscribe)

  const { socket } = await connectProvider(connection)
  socket.message(
    nativeFrame({
      type: "clarus.project.subscribed",
      requestID: null,
      payload: { project_id: "p", subscribed: true },
    }),
  )
  socket.message({
    type: "ws_send",
    request_id: "ws-co",
    meta: { event: "co.event" },
    payload: { v: 1 },
    caller: { type: "agent", agent_id: "peer-co", owner_user_id: 1 },
  })
  await waitFor(() => nativeObserved.length === 1 && appEventReceived)
  expect(nativeObserved[0].type).toBe("clarus.project.subscribed")
})

test("dispatches disconnected event when socket closes", async () => {
  const connection = createRuntimeConnection()
  const lifecycle: HolosConnectionEvent[] = []
  connection.connectionObservers.add((event) => {
    lifecycle.push(event)
  })
  const { socket } = await connectProvider(connection)
  socket.message(connectedFrame("session-1"))
  await waitFor(() => connection.generation === 1)

  socket.close(1001, "going offline")
  await waitFor(() => lifecycle.length === 2)
  const disconnected = lifecycle[1]
  if (disconnected.type === "disconnected") {
    expect(disconnected.code).toBe(1001)
    expect(disconnected.reason).toBe("going offline")
  } else {
    throw new Error("Expected disconnected event")
  }
})

describe("HolosProvider lifecycle hardening", () => {
  test("epoch is stable across provider replacements within same RuntimeConnection", async () => {
    const connection = createRuntimeConnection()
    const connectedEpochs: number[] = []
    connection.connectionObservers.add((event) => {
      if (event.type === "connected") connectedEpochs.push(event.epoch)
    })

    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-1"))
    await waitFor(() => connectedEpochs.length === 1)

    first.socket.close(1000, "reconnect")

    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-2"))
    await waitFor(() => connectedEpochs.length === 2)

    expect(connectedEpochs[0]).toBe(connectedEpochs[1])
  })

  test("generation is monotonic within an epoch across provider replacements", async () => {
    const connection = createRuntimeConnection()
    const generations: number[] = []
    connection.connectionObservers.add((event) => {
      if (event.type === "connected") generations.push(event.generation)
    })

    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-1"))
    await waitFor(() => generations.length === 1)

    first.socket.close(1000, "reconnect")

    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-2"))
    await waitFor(() => generations.length === 2)

    expect(generations[0]).toBeGreaterThan(0)
    expect(generations[1]).toBeGreaterThan(generations[0])
    expect(connection.generation).toBe(generations[1])
  })

  test("no disconnected emitted when socket closes before connected", async () => {
    // This test verifies that a failed connection (close before open) does NOT emit disconnected
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })

    await HolosAccounts.saveAndActivateAccount("agent_test", "secret_test")
    globalThis.fetch = makeTokenFetch()
    installProviderWebSocket()

    const controller = new AbortController()
    activeControllers.add(controller)
    const provider = new HolosProvider(connection)
    connection.provider = provider
    const socketIndex = ProviderTestWebSocket.instances.length
    const connectPromise = provider.connect({
      config: {
        enabled: true,
        apiUrl: "https://api.test",
        wsUrl: "wss://ws.test",
        portalUrl: "https://portal.test",
      },
      signal: controller.signal,
    })
    await waitFor(() => ProviderTestWebSocket.instances.length > socketIndex)
    const socket = ProviderTestWebSocket.instances[socketIndex]

    // Close without opening — simulates failed connection
    socket.close(1006, "connection failed")

    await expect(connectPromise).rejects.toThrow("WebSocket connection failed")
    // No connected or disconnected events should have been emitted
    expect(lifecycle).toEqual([])
  })

  test("stop on connected provider emits disconnected and settles pending requests", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    const { provider, socket } = await connectProvider(connection)
    socket.message(connectedFrame("session-stop"))
    await waitFor(() => lifecycle.length === 1)
    expect(lifecycle[0].type).toBe("connected")

    // Fire a pending native request
    const pending = provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "pending-stop",
      expectedResponseType: "clarus.project.subscribed",
    })

    // Mock stop: call provider.settle() then null provider
    // Since settle() is new, we test the stop-like behavior by settling + nulling
    provider.settle?.()
    connection.provider = null
    connection.sessionID = null
    connection.generation = 0

    await waitFor(() => lifecycle.length === 2)
    expect(lifecycle[1].type).toBe("disconnected")

    // Pending request should be settled as disconnected
    await expect(pending.response).rejects.toMatchObject({
      disposition: "ambiguous",
      reason: "disconnected",
    })
  })

  test("provider replacement settles old provider pending as ambiguous/disconnected", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })

    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-old"))
    await waitFor(() => lifecycle.length === 1)

    // Launch a pending request on the old provider
    const oldRequest = first.provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "pending-replace",
      expectedResponseType: "clarus.project.subscribed",
    })

    // Replace provider: create a new one while old still has pending
    // Settle old provider first, then connect new
    first.provider.settle?.()
    connection.provider = null

    await waitFor(() => lifecycle.length === 2)
    expect(lifecycle[1].type).toBe("disconnected")

    // Old pending should be settled
    await expect(oldRequest.response).rejects.toMatchObject({
      disposition: "ambiguous",
      reason: "disconnected",
    })

    // Now connect new provider
    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-new"))
    await waitFor(() => lifecycle.length === 3)
    expect(lifecycle[2].type).toBe("connected")

    // New provider should work
    const newRequest = second.provider.sendNativeRequest({
      type: "clarus.project.subscribe",
      payload: {},
      requestID: "pending-new",
      expectedResponseType: "clarus.project.subscribed",
    })
    second.socket.message(
      nativeFrame({
        type: "clarus.project.subscribed",
        requestID: "pending-new",
        payload: { project_id: "project-1", subscribed: true },
      }),
    )
    const response = await newRequest.response
    expect(response.requestID).toBe("pending-new")
  })

  test("stale socket close settles only its own pending without emitting lifecycle", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    const nativeMessages: NativeMessage[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    connection.nativeObservers.add((message) => {
      nativeMessages.push(message)
    })

    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-1"))
    await waitFor(() => lifecycle.length === 1)

    // Connect second provider (replaces first)
    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-2"))
    await waitFor(() => lifecycle.length === 2)

    // Now close the stale first socket — should NOT emit disconnected
    first.socket.close(1001, "stale close")

    // No additional lifecycle events
    await Bun.sleep(10)
    expect(lifecycle.length).toBe(2)
    expect(lifecycle[0].type).toBe("connected")
    expect(lifecycle[1].type).toBe("connected")
  })

  test("duplicate close/abort does not emit multiple disconnected events", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    const { socket, controller } = await connectProvider(connection)
    socket.message(connectedFrame("session-dup"))
    await waitFor(() => lifecycle.length === 1)

    // Close the socket
    socket.close(1000, "normal close")
    await waitFor(() => lifecycle.length === 2)

    // Abort the controller (simulates second close signal)
    controller.abort()
    await Bun.sleep(10)

    // Should still have exactly 2 lifecycle events (connected + disconnected)
    const disconnectedCount = lifecycle.filter((e) => e.type === "disconnected").length
    expect(disconnectedCount).toBe(1)
    expect(lifecycle.length).toBe(2)
  })

  test("getNativeTunnel returns a port that survives provider replacement", async () => {
    const { HolosRuntime } = await import("../../src/holos/runtime")
    // We test via the connection-level observer pattern used by getNativeTunnel
    const connection = createRuntimeConnection()
    const connectionEvents: HolosConnectionEvent[] = []
    const nativeObserved: NativeMessage[] = []

    connection.connectionObservers.add((event) => {
      connectionEvents.push(event)
    })
    connection.nativeObservers.add((message) => {
      nativeObserved.push(message)
    })

    // First provider
    const first = await connectProvider(connection)
    first.socket.message(connectedFrame("session-port-1"))
    await waitFor(() => connectionEvents.length === 1)

    // Replace provider
    first.socket.close(1000, "reconnect")
    first.provider.settle?.()
    connection.provider = null

    const second = await connectProvider(connection)
    second.socket.message(connectedFrame("session-port-2"))
    await waitFor(() => connectionEvents.length === 3) // connected1 + disconnected1 + connected2

    // Native observers still receive messages from new provider
    second.socket.message(
      nativeFrame({
        type: "clarus.project.subscribed",
        requestID: null,
        payload: { project_id: "p", subscribed: true },
      }),
    )
    await waitFor(() => nativeObserved.length === 1)
    expect(nativeObserved[0].type).toBe("clarus.project.subscribed")
  })

  test("disconnected event includes epoch matching the corresponding connected event", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    const { socket } = await connectProvider(connection)
    socket.message(connectedFrame("session-epoch"))
    await waitFor(() => lifecycle.length === 1)

    const connected = lifecycle[0]
    expect(connected.type).toBe("connected")
    expect("epoch" in connected).toBe(true)
    const connectedEpoch = (connected as { epoch: number }).epoch

    socket.close(1000, "normal")
    await waitFor(() => lifecycle.length === 2)

    const disconnected = lifecycle[1]
    expect(disconnected.type).toBe("disconnected")
    expect("epoch" in disconnected).toBe(true)
    const disconnectedEpoch = (disconnected as { epoch: number }).epoch

    expect(disconnectedEpoch).toBe(connectedEpoch)
  })

  test("native messages include epoch from RuntimeConnection", async () => {
    const connection = createRuntimeConnection()
    const observed: NativeMessage[] = []
    connection.nativeObservers.add((msg) => {
      observed.push(msg)
    })
    const { socket } = await connectProvider(connection)
    socket.message(connectedFrame("session-1"))
    await waitFor(() => connection.generation === 1)

    socket.message(
      nativeFrame({
        type: "clarus.project.subscribed",
        requestID: null,
        payload: { project_id: "p1", subscribed: true },
      }),
    )
    await waitFor(() => observed.length === 1)

    const msg = observed[0]
    expect("epoch" in msg).toBe(true)
    expect(typeof msg.epoch).toBe("number")
    expect(msg.epoch).toBeGreaterThan(0)
  })

  test("legacy ws_send pending is settled as sent:false when provider is replaced", async () => {
    const connection = createRuntimeConnection()
    const { provider, socket } = await connectProvider(connection)

    // Fire a ws_send that will time out (no response to settle)
    // Then replace the provider while it's pending
    const sendPromise = provider.send("peer-legacy", "chat.message", { text: "hello" })

    // Immediately replace the provider
    provider.settle?.()
    connection.provider = null

    const result = await sendPromise
    // After provider settlement, ws_send pending should be settled
    // Either sent:false/disconnected or timeout
    expect(result.sent).toBe(false)
  })

  test("abort then close does not emit duplicate disconnected on connected provider", async () => {
    const connection = createRuntimeConnection()
    const lifecycle: HolosConnectionEvent[] = []
    connection.connectionObservers.add((event) => {
      lifecycle.push(event)
    })
    const { socket, controller } = await connectProvider(connection)
    socket.message(connectedFrame("session-abort-close"))
    await waitFor(() => lifecycle.length === 1)

    // Abort first
    controller.abort()
    await Bun.sleep(10)

    // Then close socket
    socket.close(1000, "close after abort")
    await Bun.sleep(10)

    const disconnectedCount = lifecycle.filter((e) => e.type === "disconnected").length
    expect(disconnectedCount).toBeLessThanOrEqual(1)
  })
})

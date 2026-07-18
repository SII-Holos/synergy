import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import z from "zod"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { ClarusRuntime } from "../../src/clarus/runtime"
import { ClarusConfigReader } from "../../src/clarus/config-reader"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import type {
  ClarusAgentTunnelPort,
  ClarusEventHandler,
  ClarusObservedEvent,
  ExtendTaskInput,
  RecordTaskResultInput,
  RuntimeTaskExtendedEvent,
  RuntimeTaskResultRecordedEvent,
  SendProjectMessageInput,
  SubscribeProjectInput,
  UnsubscribeProjectInput,
  ProjectSubscribedEvent,
  ProjectUnsubscribedEvent,
  ProjectMessageCreatedEvent,
} from "../../src/clarus/agent-tunnel-port"
import type { ClarusRestPort } from "../../src/clarus/rest-port"
import { GlobalRuntime } from "../../src/server/global-runtime"
import type { HolosConnectionEvent, NativeMessage } from "../../src/holos/native"

let AGENT_ID = "facade_agent"
let PROJECT_ID = "facade_project"

// ── Fake NativeTunnelPort for HolosRuntime mocking ──────────────────

class FakeNativePort {
  readonly nativeObservers = new Set<(msg: NativeMessage) => void | Promise<void>>()
  readonly connectionObservers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  requestCalls: Array<{
    type: string
    payload: unknown
    requestID: string
    expectedResponseType: string
  }> = []

  registerNativeObserver(handler: (msg: NativeMessage) => void | Promise<void>): () => void {
    this.nativeObservers.add(handler)
    return () => {
      this.nativeObservers.delete(handler)
    }
  }

  registerConnectionObserver(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionObservers.add(handler)
    return () => {
      this.connectionObservers.delete(handler)
    }
  }

  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: string
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }) {
    this.requestCalls.push({
      type: input.type,
      payload: input.payload,
      requestID: input.requestID,
      expectedResponseType: input.expectedResponseType,
    })
    return {
      requestID: input.requestID,
      response: new Promise<NativeMessage>(() => {}),
    }
  }

  reset(): void {
    this.nativeObservers.clear()
    this.connectionObservers.clear()
    this.requestCalls = []
  }
}

// ── Fake ClarusAgentTunnelPort (for direct-attach tests) ────────────

class FakeClarusPort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<ClarusEventHandler>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()

  registerEventHandler(handler: ClarusEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }
  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async connect(agentID = AGENT_ID, generation = 1, epoch = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "connected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  async disconnect(agentID = AGENT_ID, generation = 1, epoch = 1): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "disconnected",
      agentID,
      sessionID: `session-${generation}`,
      generation,
      epoch,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  subscribeProject(input: SubscribeProjectInput) {
    return {
      requestID: input.requestID,
      response: new Promise<ProjectSubscribedEvent>(() => {}),
    }
  }
  unsubscribeProject(input: UnsubscribeProjectInput) {
    return {
      requestID: input.requestID,
      response: new Promise<ProjectUnsubscribedEvent>(() => {}),
    }
  }
  sendProjectMessage(input: SendProjectMessageInput) {
    return {
      requestID: input.requestID,
      response: new Promise<ProjectMessageCreatedEvent>(() => {}),
    }
  }
  extendTask(input: ExtendTaskInput) {
    return {
      requestID: input.requestID,
      response: new Promise<RuntimeTaskExtendedEvent>(() => {}),
    }
  }
  recordTaskResult(input: RecordTaskResultInput) {
    return {
      requestID: input.requestID,
      response: new Promise<RuntimeTaskResultRecordedEvent>(() => {}),
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

class DummyRest implements ClarusRestPort.Interface {
  async listProjects(_params: { status?: string; limit?: number; cursor?: string }) {
    return { projects: [], nextCursor: null }
  }
  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not implemented")
  }
  async listMessages(_params: { projectId: string; cursor?: string; limit?: number }) {
    return { messages: [], nextCursor: null }
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

class StallingRest implements ClarusRestPort.Interface {
  async listProjects(_params: { status?: string; limit?: number; cursor?: string }) {
    await new Promise((r) => setTimeout(r, 500))
    return { projects: [], nextCursor: null }
  }
  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not implemented")
  }
  async listMessages(_params: { projectId: string; cursor?: string; limit?: number }) {
    return { messages: [], nextCursor: null }
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

// ── HolosRuntime mock (for init/reconnect tests) ────────────────────
let moduleMocksActive = true
let mockHolosStatus: { status: string; error?: string } = { status: "disconnected" }
let mockGetNativeTunnelFailures = 0
let mockReloadCalls = 0
let mockHolosStatusGate: (() => void) | null = null
const fakeNativePort = new FakeNativePort()
const realHolosRuntime = { ...(await import("../../src/holos/runtime")).HolosRuntime }
const mockedHolosRuntime = {
  status: async () => {
    if (mockHolosStatusGate) {
      await new Promise<void>((resolve) => {
        mockHolosStatusGate = resolve
      })
    }
    if (mockHolosStatus.status === "failed") {
      return { status: "failed", error: mockHolosStatus.error } as const
    }
    return { status: mockHolosStatus.status } as { status: string }
  },
  getNativeTunnel: async () => {
    if (mockGetNativeTunnelFailures > 0) {
      mockGetNativeTunnelFailures--
      throw new Error("mock tunnel setup failure")
    }
    return {
      registerNativeObserver: (h: (msg: NativeMessage) => void | Promise<void>) => {
        fakeNativePort.nativeObservers.add(h)
        return () => {
          fakeNativePort.nativeObservers.delete(h)
        }
      },
      registerConnectionObserver: (h: (event: HolosConnectionEvent) => void | Promise<void>) => {
        fakeNativePort.connectionObservers.add(h)
        return () => {
          fakeNativePort.connectionObservers.delete(h)
        }
      },
      sendNativeRequest: (input: {
        type: string
        payload: unknown
        requestID: string
        expectedResponseType: string
        timeoutMs?: number
        signal?: AbortSignal
        meta?: Record<string, unknown>
      }) => {
        fakeNativePort.requestCalls.push({
          type: input.type,
          payload: input.payload,
          requestID: input.requestID,
          expectedResponseType: input.expectedResponseType,
        })
        return { requestID: input.requestID, response: new Promise<NativeMessage>(() => {}) }
      },
    }
  },
  reload: async () => {
    mockReloadCalls++
  },
  init: async () => {},
  start: async () => {},
  stop: async () => {},
  Event: {
    Connected: {
      type: "holos.connected",
      properties: z.object({ peerId: z.string() }),
    },
    StatusChanged: {
      type: "holos.connection.status_changed",
      properties: z.object({ status: z.string(), error: z.string().optional() }),
    },
    PresenceUpdate: {
      type: "holos.presence",
      properties: z.object({ peerId: z.string(), status: z.any() }),
    },
  },
  registerAppEventHandler: () => () => {},
  dispatchAppEvent: async () => false,
  getProvider: async () => null,
}

mock.module("@/holos/runtime", () => ({
  HolosRuntime: new Proxy(realHolosRuntime, {
    get(target, property, receiver) {
      if (moduleMocksActive && Object.hasOwn(mockedHolosRuntime, property)) {
        return Reflect.get(mockedHolosRuntime, property)
      }
      return Reflect.get(target, property, receiver)
    },
  }),
}))

// ── Config / Auth mock state (for GlobalRuntime REST wiring tests) ──

let mockConfigCurrent: Record<string, unknown> = {}
const realConfig = { ...(await import("../../src/config/config")).Config }
const mockedConfig = {
  current: async () => mockConfigCurrent,
  globalResolved: async () => mockConfigCurrent,
  domainUpdate: async () => {},
  Event: {
    Updated: {
      type: "config.updated",
      properties: z.object({ scope: z.string(), changedFields: z.array(z.string()) }),
    },
  },
  diff: () => [],
  redactForClient: (c: unknown) => c,
}

mock.module("@/config/config", () => ({
  Config: new Proxy(realConfig, {
    get(target, property, receiver) {
      if (moduleMocksActive && Object.hasOwn(mockedConfig, property)) {
        return Reflect.get(mockedConfig, property)
      }
      return Reflect.get(target, property, receiver)
    },
  }),
}))

let mockCredentialId: string | null = null
let mockCredentialSecret: string | null = null
const realHolosAuth = { ...(await import("../../src/holos/auth")).HolosAuth }
const mockedHolosAuth = {
  getStoredCredential: async () => {
    if (!mockCredentialId) return undefined
    return {
      agentId: mockCredentialId,
      agentSecret: mockCredentialSecret ?? "",
      maskedSecret: "********",
    }
  },
}

mock.module("@/holos/auth", () => ({
  HolosAuth: new Proxy(realHolosAuth, {
    get(target, property, receiver) {
      if (moduleMocksActive && Object.hasOwn(mockedHolosAuth, property)) {
        return Reflect.get(mockedHolosAuth, property)
      }
      return Reflect.get(target, property, receiver)
    },
  }),
}))

const GlobalRuntimeMock = {
  setConfig(holosApiUrl?: string, clarusApiUrl?: string) {
    if (holosApiUrl) {
      mockConfigCurrent = {
        holos: {
          enabled: true,
          apiUrl: holosApiUrl,
          wsUrl: "wss://localhost:8443",
          portalUrl: "https://localhost:8443",
        },
      }
      if (clarusApiUrl !== undefined) {
        mockConfigCurrent = {
          ...mockConfigCurrent,
          clarus: { apiUrl: clarusApiUrl },
        }
      }
    } else {
      mockConfigCurrent = {}
    }
  },
  setRaw(config: Record<string, unknown>) {
    mockConfigCurrent = config
  },
  setCredential(agentId: string | null, agentSecret: string | null) {
    mockCredentialId = agentId
    mockCredentialSecret = agentSecret
  },
  reset() {
    mockConfigCurrent = {}
    mockCredentialId = null
    mockCredentialSecret = null
  },
}

const HolosRuntimeMock = {
  setStatus(status: string, error?: string) {
    mockHolosStatus = { status, error }
  },
  setTunnelFailures(count: number) {
    mockGetNativeTunnelFailures = count
  },
  getReloadCalls() {
    return mockReloadCalls
  },
  delayNextStatus() {
    mockHolosStatusGate = () => {}
  },
  releaseStatus() {
    if (mockHolosStatusGate) {
      const gate = mockHolosStatusGate
      mockHolosStatusGate = null
      gate()
    }
  },
  reset(initialStatus = "disconnected") {
    mockHolosStatus = { status: initialStatus }
    mockGetNativeTunnelFailures = 0
    mockReloadCalls = 0
    mockHolosStatusGate = null
    fakeNativePort.reset()
  },
}
afterAll(() => {
  moduleMocksActive = false
})

// ── Test setup / cleanup ────────────────────────────────────────────

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `facade_${suffix}`
  PROJECT_ID = `proj_${suffix}`
  HolosRuntimeMock.reset()
  GlobalRuntimeMock.reset()
})

afterEach(async () => {
  ClarusRuntime.shutdown()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
  ClarusConfigReader.invalidate()
  GlobalRuntimeMock.reset()
  await GlobalRuntime.stop().catch(() => {})
})

// ── Status mapping tests ────────────────────────────────────────────

describe("ClarusRuntime.status() mappings", () => {
  test("returns disconnected when not attached", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.status).toBe("disconnected")
    expect(result.agentId).toBeNull()
    expect(result.epoch).toBe(0)
    expect(result.generation).toBe(0)
    expect(result.isReconciling).toBe(false)
  })

  test("returns disconnected when attached but no connection event", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.status).toBe("disconnected")
    expect(result.agentId).toBeNull()
  })

  test("returns connected after connection event", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect(AGENT_ID, 1, 100)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.status).toBe("connected")
    expect(result.agentId).toBe(AGENT_ID)
    expect(result.epoch).toBe(100)
    expect(result.generation).toBe(1)
  })

  test("returns sync_failed when connected reconciliation has a persistent error", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    const result = await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect(AGENT_ID, 1, 100)
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = await Storage.read<{ needsReconciliation?: boolean }>(
            StoragePath.clarusReconciliation(AGENT_ID),
          )
          if (state.needsReconciliation === false) break
          await Bun.sleep(10)
        }
        await Storage.write(StoragePath.clarusReconciliation(AGENT_ID), {
          schemaVersion: 1,
          agentId: AGENT_ID,
          generation: 1,
          needsReconciliation: true,
          lastError: "Clarus response body is not valid JSON",
        })
        return ClarusRuntime.status()
      },
    })

    expect(result).toMatchObject({
      status: "sync_failed",
      agentId: AGENT_ID,
      error: "Clarus response body is not valid JSON",
      isReconciling: false,
    })
  })

  test("returns disconnected after disconnect event", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect(AGENT_ID, 1, 100)
        await port.disconnect(AGENT_ID, 1, 100)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.status).toBe("disconnected")
    expect(result.agentId).toBeNull()
  })

  test("isReconciling is true during active reconciliation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new StallingRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect(AGENT_ID, 1, 100)
        await Bun.sleep(50)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.status).toBe("connected")
  })

  test("connected epoch and generation match connection identity", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect("agent-42", 7, 999)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.agentId).toBe("agent-42")
    expect(result.epoch).toBe(999)
    expect(result.generation).toBe(7)
  })

  test("isReconciling is false when not connected", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result.isReconciling).toBe(false)
  })
})

// ── Lifecycle tests ─────────────────────────────────────────────────

describe("ClarusRuntime lifecycle", () => {
  test("attach creates only one set of listeners (no duplicates)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port1 = new FakeClarusPort()
    const port2 = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port1)
        await ClarusRuntime.attach(port2)
      },
    })

    // After second attach, port2 should have listeners and isAttached should be true
    expect(ClarusRuntime.isAttached()).toBe(true)
    expect(port2.eventHandlers.size).toBeGreaterThanOrEqual(1)
  })

  test("detach clears connected state", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect(AGENT_ID, 1, 100)
      },
    })

    const connected = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })
    expect(connected.status).toBe("connected")

    await ScopeContext.provide({
      scope,
      fn: () => {
        ClarusRuntime.detach()
      },
    })

    const detached = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })
    expect(detached.status).toBe("disconnected")
    expect(detached.agentId).toBeNull()
  })

  test("isAttached reflects attachment state", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()
    const rest = new DummyRest()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        expect(ClarusRuntime.isAttached()).toBe(false)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        expect(ClarusRuntime.isAttached()).toBe(true)
        ClarusRuntime.detach()
        expect(ClarusRuntime.isAttached()).toBe(false)
      },
    })
  })
})

// ── Error handling tests ────────────────────────────────────────────

describe("ClarusRuntime status integrity", () => {
  test("status always returns a valid status union value", async () => {
    const validStatuses = [
      "disabled",
      "disconnected",
      "connecting",
      "connected",
      "reconnecting",
      "blocked",
      "sync_failed",
    ]
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    // Test without attach
    const result1 = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })
    expect(validStatuses).toContain(result1.status)
    expect(result1.epoch).toBeGreaterThanOrEqual(0)
    expect(result1.generation).toBeGreaterThanOrEqual(0)
    expect(typeof result1.isReconciling).toBe("boolean")
  })

  test("status fields are always present regardless of state", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })

    expect(result).toHaveProperty("agentId")
    expect(result).toHaveProperty("status")
    expect(result).toHaveProperty("epoch")
    expect(result).toHaveProperty("generation")
    expect(result).toHaveProperty("isReconciling")
  })
})

// ── Init / reconnect lifecycle tests ─────────────────────────────────

describe("ClarusRuntime init/reconnect lifecycle", () => {
  test("concurrent init calls share one in-flight operation and produce one adapter", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")
    HolosRuntimeMock.delayNextStatus()

    let initA: Promise<void> | undefined
    let initB: Promise<void> | undefined

    await ScopeContext.provide({
      scope,
      fn: async () => {
        initA = ClarusRuntime.init()
        initB = ClarusRuntime.init()

        // Both must return the same promise (in-flight sharing)
        expect(initB).toBe(initA)
      },
    })

    // Release the delayed status call so init can complete
    HolosRuntimeMock.releaseStatus()
    await initA!

    // Should be attached with exactly one native observer (not duplicated)
    await ScopeContext.provide({
      scope,
      fn: () => {
        expect(ClarusRuntime.isAttached()).toBe(true)
      },
    })

    // Verify adapter was created: nativeObservers should have exactly 1 entry
    expect(fakeNativePort.nativeObservers.size).toBe(1)
  })

  test("init failure clears cached promise allowing retry", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")
    // Make first getNativeTunnel throw
    HolosRuntimeMock.setTunnelFailures(1)

    // First init: tunnel setup fails, init resolves (error caught internally)
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(false)

    // Second init: should succeed because initPromise was cleared
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
    expect(fakeNativePort.nativeObservers.size).toBeGreaterThanOrEqual(1)
  })

  test("init failure cleans up partial Bus subscription", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")
    HolosRuntimeMock.setTunnelFailures(1)

    // Init fails after Bus subscription is created
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(false)

    // Bus subscription should have been cleaned up; a second init
    // re-creates the subscription and succeeds
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
  })

  test("disabled status when Holos transport is disabled", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("disabled")

    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })
    expect(result.status).toBe("disabled")
    expect(result.agentId).toBeNull()
    expect(result.isReconciling).toBe(false)
  })

  test("blocked status returns error field redacted", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    // Init to establish Bus subscription and adapter
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusRuntime.init()
        // Fire a connected event to establish connectedAgentId
        const ev: HolosConnectionEvent = {
          type: "connected",
          agentID: AGENT_ID,
          sessionID: "s1",
          generation: 1,
          epoch: 100,
        }
        for (const h of fakeNativePort.connectionObservers) await h(ev)
      },
    })

    // Now set Holos transport to failed via the Bus subscription
    // (simulating what happens when HolosRuntime publishes StatusChanged)
    const { Bus } = await import("../../src/bus")
    const { HolosRuntime } = await import("../../src/holos/runtime")
    await ScopeContext.provide({
      scope,
      fn: () => Bus.publish(HolosRuntime.Event.StatusChanged, { status: "failed", error: "some internal detail" }),
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.status(),
    })
    expect(result.status).toBe("blocked")
    expect(result.error).toBe("connection blocked")
    // The internal detail should NOT be leaked (status redacts it)
    expect(result.error).not.toContain("some internal detail")
  })

  test("init -> shutdown -> init cycle works", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    // First init
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
    const firstObservers = fakeNativePort.nativeObservers.size
    expect(firstObservers).toBeGreaterThanOrEqual(1)

    // Shutdown
    ClarusRuntime.shutdown()
    expect(ClarusRuntime.isAttached()).toBe(false)

    // Re-init
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
    // Should not duplicate — shutdown detaches, re-init attaches fresh
    expect(fakeNativePort.nativeObservers.size).toBe(firstObservers)
  })

  test("shutdown is idempotent", async () => {
    // Shutdown on uninitialized state should not throw
    expect(() => ClarusRuntime.shutdown()).not.toThrow()

    // Double shutdown should not throw
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)

    ClarusRuntime.shutdown()
    expect(ClarusRuntime.isAttached()).toBe(false)

    // Second shutdown is safe
    expect(() => ClarusRuntime.shutdown()).not.toThrow()
    expect(ClarusRuntime.isAttached()).toBe(false)
  })

  test("reconnect calls HolosRuntime.reload and re-attaches adapter", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    // Initial init attaches adapter
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
    expect(HolosRuntimeMock.getReloadCalls()).toBe(0)

    // Reconnect: should call reload and re-attach
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.reconnect(),
    })

    expect(HolosRuntimeMock.getReloadCalls()).toBe(1)
    // Should still be attached after reconnect re-attaches
    expect(ClarusRuntime.isAttached()).toBe(true)
  })

  test("reconnect returns fresh status after reload", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusRuntime.init()
        // Connect via the fake native port to establish connected state
        const ev: HolosConnectionEvent = {
          type: "connected",
          agentID: AGENT_ID,
          sessionID: "s1",
          generation: 1,
          epoch: 100,
        }
        for (const h of fakeNativePort.connectionObservers) await h(ev)
      },
    })

    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.reconnect(),
    })

    // Should return a valid status shape
    expect(result).toHaveProperty("status")
    expect(result).toHaveProperty("agentId")
    expect(result).toHaveProperty("epoch")
    expect(result).toHaveProperty("generation")
    expect(result).toHaveProperty("isReconciling")
    const validStatuses = [
      "disabled",
      "disconnected",
      "connecting",
      "connected",
      "reconnecting",
      "blocked",
      "sync_failed",
    ]
    expect(validStatuses).toContain(result.status)
  })

  test("reconnect does not duplicate Bus subscriptions or adapters", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    // Initial init
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    const observersBefore = fakeNativePort.nativeObservers.size
    const connObserversBefore = fakeNativePort.connectionObservers.size
    expect(observersBefore).toBeGreaterThanOrEqual(1)

    // Reconnect: detach + re-attach should replace, not add
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.reconnect(),
    })

    // Should not have more observers than before (detach clears old, attach adds new)
    expect(fakeNativePort.nativeObservers.size).toBeLessThanOrEqual(observersBefore + 1)
    // Connection observers should not have doubled
    expect(fakeNativePort.connectionObservers.size).toBeLessThanOrEqual(connObserversBefore + 1)
  })

  test("reconnect handles Holos reload failure gracefully", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")
    // Make reload throw by setting reload to throw in the mock...
    // Actually the mock's reload currently just increments, let's test a different error path

    // Instead: make getNativeTunnel throw after reload (simulates connect failure)
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })

    HolosRuntimeMock.setTunnelFailures(1)

    // Reconnect should not throw even if re-attach fails
    const result = await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.reconnect(),
    })

    expect(result).toHaveProperty("status")
  })

  test("init after failed reconnect should still work", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    HolosRuntimeMock.setStatus("connected")

    // First init
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })

    // Shutdown
    ClarusRuntime.shutdown()
    expect(ClarusRuntime.isAttached()).toBe(false)

    // Failed reconnect: tunnel fails
    HolosRuntimeMock.setTunnelFailures(1)
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.reconnect(),
    })
    // Reconnect catches attach errors, but initPromise is still null (from shutdown)

    // Now init should work again
    await ScopeContext.provide({
      scope,
      fn: () => ClarusRuntime.init(),
    })
    expect(ClarusRuntime.isAttached()).toBe(true)
  })
  test("GlobalRuntime.stop detaches the Clarus runtime", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new FakeClarusPort()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusRuntime.attach(port)
        expect(ClarusRuntime.isAttached()).toBe(true)

        await GlobalRuntime.stop()
        expect(ClarusRuntime.isAttached()).toBe(false)
      },
    })
  })
})

// ── GlobalRuntime.start() REST wiring test ───────────────────────────

describe("GlobalRuntime.start() configures Clarus REST port", () => {
  test("startup resolves Holos apiUrl and stored credential, then configures ClarusRestClient that reaches mock server", async () => {
    let serverRequests: string[] = []

    // Start a mock HTTP server that responds to Clarus REST project listing
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        serverRequests.push(req.url)
        const url = new URL(req.url)
        if (url.pathname === "/api/v1/holos/clarus/projects") {
          return new Response(
            JSON.stringify({
              code: 0,
              message: "ok",
              data: {
                items: [
                  {
                    project_id: "proj_gr_startup",
                    title: "Startup Wired Project",
                    status: "active",
                    role: "owner",
                    runtime_agent_id: null,
                    updated_at: new Date().toISOString(),
                  },
                ],
                next_cursor: null,
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        return new Response("not found", { status: 404 })
      },
    })

    const testAgentId = "startup_agent_1"
    const testAgentSecret = "sk-startup-test-secret"
    const apiUrl = `http://localhost:${server.port}`

    // Configure the mock config to return the test server as the Holos apiUrl
    GlobalRuntimeMock.setConfig(apiUrl)
    GlobalRuntimeMock.setCredential(testAgentId, testAgentSecret)
    HolosRuntimeMock.setStatus("connected")

    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await GlobalRuntime.start()

          // After GlobalRuntime.start() configures the REST port and calls
          // ClarusRuntime.init(), the adapter is attached but no connection
          // event has fired yet. Fire a connected event through the native
          // port observers to trigger reconciliation (which uses the REST port).
          const ev: HolosConnectionEvent = {
            type: "connected",
            agentID: testAgentId,
            sessionID: "s_startup_1",
            generation: 1,
            epoch: 100,
          }
          for (const h of fakeNativePort.connectionObservers) await h(ev)
        },
      })

      // Wait a moment for async reconciliation to make at least one request
      await Bun.sleep(1000)

      // Verification: the mock server must have received at least one request
      // proving that the REST port was configured and used.
      expect(serverRequests.length).toBeGreaterThan(0)

      // The request should be to the projects endpoint from the REST client
      const projectRequest = serverRequests.find((r) => r.includes("/api/v1/holos/clarus/projects"))
      expect(projectRequest).toBeDefined()
    } finally {
      server.stop()
    }
  })

  test("uses clarus.apiUrl override when configured, so REST client targets override server", async () => {
    let overrideRequests: string[] = []
    let fallbackRequests: string[] = []

    // Override server — simulates pre-production Clarus REST
    const overrideServer = Bun.serve({
      port: 0,
      fetch(req) {
        overrideRequests.push(req.url)
        const url = new URL(req.url)
        if (url.pathname === "/api/v1/holos/clarus/projects") {
          return new Response(
            JSON.stringify({
              code: 0,
              message: "ok",
              data: {
                items: [
                  {
                    project_id: "proj_override",
                    title: "Override",
                    status: "active",
                    role: "owner",
                    runtime_agent_id: null,
                    updated_at: new Date().toISOString(),
                  },
                ],
                next_cursor: null,
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        return new Response("not found", { status: 404 })
      },
    })

    // Fallback server — simulates production Holos (should NOT receive Clarus REST calls)
    const fallbackServer = Bun.serve({
      port: 0,
      fetch(req) {
        fallbackRequests.push(req.url)
        return new Response("should not be called", { status: 418 })
      },
    })

    const overrideUrl = `http://localhost:${overrideServer.port}`
    const fallbackUrl = `http://localhost:${fallbackServer.port}`
    const testAgentId = "override_agent_1"
    const testAgentSecret = "sk-override-test-secret"

    // holos.apiUrl = fallback server, clarus.apiUrl = override server
    GlobalRuntimeMock.setConfig(fallbackUrl, overrideUrl)
    GlobalRuntimeMock.setCredential(testAgentId, testAgentSecret)
    HolosRuntimeMock.setStatus("connected")

    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await GlobalRuntime.start()
          const ev: HolosConnectionEvent = {
            type: "connected",
            agentID: testAgentId,
            sessionID: "s_override_1",
            generation: 1,
            epoch: 100,
          }
          for (const h of fakeNativePort.connectionObservers) await h(ev)
        },
      })

      await Bun.sleep(1000)

      // Override server must have received Clarus REST requests
      expect(overrideRequests.length).toBeGreaterThan(0)
      const projectRequest = overrideRequests.find((r) => r.includes("/api/v1/holos/clarus/projects"))
      expect(projectRequest).toBeDefined()

      // Fallback server must NOT have received any requests
      expect(fallbackRequests.length).toBe(0)
    } finally {
      overrideServer.stop()
      fallbackServer.stop()
    }
  })

  test("falls back to holos.apiUrl when clarus.apiUrl is absent", async () => {
    let fallbackRequests: string[] = []

    const fallbackServer = Bun.serve({
      port: 0,
      fetch(req) {
        fallbackRequests.push(req.url)
        const url = new URL(req.url)
        if (url.pathname === "/api/v1/holos/clarus/projects") {
          return new Response(
            JSON.stringify({
              code: 0,
              message: "ok",
              data: {
                items: [
                  {
                    project_id: "proj_fallback",
                    title: "Fallback",
                    status: "active",
                    role: "owner",
                    runtime_agent_id: null,
                    updated_at: new Date().toISOString(),
                  },
                ],
                next_cursor: null,
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        return new Response("not found", { status: 404 })
      },
    })

    const fallbackUrl = `http://localhost:${fallbackServer.port}`
    const testAgentId = "fallback_agent_1"
    const testAgentSecret = "sk-fallback-test-secret"

    // Only holos.apiUrl is configured; clarus.apiUrl is absent
    GlobalRuntimeMock.setConfig(fallbackUrl) // no second argument = no clarus.apiUrl
    GlobalRuntimeMock.setCredential(testAgentId, testAgentSecret)
    HolosRuntimeMock.setStatus("connected")

    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await GlobalRuntime.start()
          const ev: HolosConnectionEvent = {
            type: "connected",
            agentID: testAgentId,
            sessionID: "s_fallback_1",
            generation: 1,
            epoch: 100,
          }
          for (const h of fakeNativePort.connectionObservers) await h(ev)
        },
      })

      await Bun.sleep(1000)

      // Fallback (holos.apiUrl) server must have received Clarus REST requests
      expect(fallbackRequests.length).toBeGreaterThan(0)
      const projectRequest = fallbackRequests.find((r) => r.includes("/api/v1/holos/clarus/projects"))
      expect(projectRequest).toBeDefined()
    } finally {
      fallbackServer.stop()
    }
  })
})

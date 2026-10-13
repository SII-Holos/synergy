import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserEvent,
  BrowserEventSchema,
  type BrowserNativePresentationCapabilityResult,
  type BrowserNativePresentationTicketResult,
} from "@ericsanchezok/synergy-browser-core"
import type { BrowserNativeViewBridge } from "../../../../src/context/platform"
import { createBrowserStore } from "../../../../src/components/workspace/browser/browser-store"

// createBrowserWebSocket reads the platform bridge through usePlatform() at
// construction time, so the bridge must be a mutable module-level reference
// that each test can swap before mounting the handle.
let bridge: BrowserNativeViewBridge | null = null

mock.module("@/context/sdk", () => ({
  useSDK: () => ({
    url: "http://127.0.0.1:4096",
    client: { browser: {} },
    directory: undefined,
    scopeID: "home",
    scopeKey: "home",
  }),
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ browserNative: bridge }),
}))

// The events socket is a real WebSocket in production; swapping the global
// lets us capture the constructed URL without any network access.
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = MockWebSocket.CONNECTING
  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }
  listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void) {
    const callbacks = this.listeners.get(type) ?? []
    callbacks.push(listener)
    this.listeners.set(type, callbacks)
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  close() {
    this.readyState = 3
  }
}

function bridgeStub(
  overrides: Partial<Pick<BrowserNativeViewBridge, "presentationCapability" | "createPresentationTicket">> = {},
): BrowserNativeViewBridge {
  return {
    async attachView() {},
    async detachView() {},
    async focusView() {},
    async resizeView() {},
    async retryPage() {},
    async presentationCapability() {
      return { protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: true, status: "ready" }
    },
    async createPresentationTicket() {
      return { ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION, ticket: "ticket" }
    },
    ...overrides,
  }
}

const OriginalWebSocket = globalThis.WebSocket

const { createBrowserWebSocket } = await import("../../../../src/components/workspace/browser/browser-ws")

function mountNativeWebSocket() {
  Object.defineProperty(globalThis, "WebSocket", {
    value: MockWebSocket,
    configurable: true,
    writable: true,
  })
  MockWebSocket.instances = []
}

function mountHandle(client?: ReturnType<typeof createSynergyClient>) {
  const store = createBrowserStore()
  let disposeRoot: (() => void) | undefined
  const handle = createRoot((dispose) => {
    disposeRoot = dispose
    return createBrowserWebSocket(store, {
      client,
      sessionID: "ses_1",
      ownerKey: "owner-1",
      routeDirectory: "aG9tZQ",
      presentation: "native",
    })
  })
  return { store, handle, dispose: () => disposeRoot?.() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const testPage = {
  id: "page-1",
  profileId: "personal",
  status: "active" as const,
  url: "https://example.com/one",
  title: "Initial page",
  isLoading: false,
  lastActiveAt: null,
}

test.each(["updated", "closed", "unrelated"] as const)(
  "late navigation response preserves %s canonical pages",
  async (event) => {
    mountNativeWebSocket()
    bridge = bridgeStub()
    const requested = deferred<void>()
    const reply = deferred<Response>()
    const client = createSynergyClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async () => {
          requested.resolve()
          return reply.promise
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const { store, handle, dispose } = mountHandle(client)
    try {
      store.replacePages([{ ...testPage }])
      await sleep(30)
      const pending = handle.send({ type: "navigate", pageId: testPage.id, url: "https://example.com/two" })
      await requested.promise
      const page = {
        ...testPage,
        id: event === "unrelated" ? "page-2" : testPage.id,
        title: "Committed title",
        url: "https://example.com/two",
      }
      const payload =
        event === "closed"
          ? { type: "page.closed", pageId: testPage.id }
          : { type: event === "unrelated" ? "page.created" : "page.loaded", page }
      MockWebSocket.instances.at(-1)!.emit("message", {
        data: JSON.stringify(
          BrowserEventSchema.parse({
            ...payload,
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            seq: 1,
            epoch: "test",
          }),
        ),
      })
      if (event === "closed") expect(store.session.pages).toHaveLength(0)
      else expect(store.session.pages.find((item) => item.id === page.id)?.title).toBe("Committed title")
      reply.resolve(
        Response.json({
          type: "control.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          result: {
            type: "navigation",
            page: { ...testPage, title: "", url: "https://example.com/two", isLoading: true },
            settled: true,
            settleReason: "none",
            settleElapsedMs: 0,
            inflightRequests: 1,
          },
        }),
      )
      await pending
      if (event === "closed") expect(store.session.pages).toHaveLength(0)
      else if (event === "updated") expect(store.session.pages).toEqual([page])
      else expect(store.session.pages).toEqual([testPage, page])
    } finally {
      dispose()
    }
  },
)

test.each(["updated", "closed", "suspended", "event-after-reply"] as const)(
  "late open response preserves %s canonical state",
  async (event) => {
    mountNativeWebSocket()
    bridge = bridgeStub()
    const requested = deferred<void>()
    const reply = deferred<Response>()
    const page = {
      ...testPage,
      title: "Canonical title",
      status: event === "suspended" ? ("suspended" as const) : ("active" as const),
    }
    const client = createSynergyClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          if (request.method === "GET")
            return Response.json({
              type: "session.state",
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              ownerKey: "owner-1",
              pages: event === "closed" ? [] : [page],
              hostStatus: "ready",
              presentation: null,
              seq: 3,
              epoch: "test",
            })
          requested.resolve()
          return reply.promise
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const { store, handle, dispose } = mountHandle(client)
    try {
      await sleep(30)
      const pending = handle.send({ type: "page.open", url: testPage.url })
      await requested.promise
      if (event !== "event-after-reply") {
        const emit = (payload: Record<string, unknown>, seq: number) =>
          MockWebSocket.instances.at(-1)!.emit("message", {
            data: JSON.stringify(
              BrowserEventSchema.parse({ ...payload, protocolVersion: BROWSER_PROTOCOL_VERSION, seq, epoch: "test" }),
            ),
          })
        emit({ type: "page.created", page }, 1)
        if (event === "closed") emit({ type: "page.closed", pageId: page.id }, 2)
        if (event === "suspended") emit({ type: "host.status", pageId: page.id, status: "detached" }, 2)
      }
      reply.resolve(Response.json({ ...testPage, title: "", isLoading: true }))
      const opened = await pending
      expect(store.session.pages).toEqual(event === "closed" ? [] : [page])
      expect(opened).toEqual(event === "closed" ? undefined : page)
      if (event === "suspended") expect(store.hostStatuses[page.id]).toBe("detached")
      if (event === "closed") expect(store.hostStatuses[page.id]).toBeUndefined()
      if (event === "event-after-reply") {
        const socket = MockWebSocket.instances.at(-1)!
        socket.emit("open")
        socket.readyState = MockWebSocket.OPEN
        socket.emit("message", {
          data: JSON.stringify(
            BrowserEventSchema.parse({
              type: "page.created",
              page: testPage,
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              seq: 1,
              epoch: "test",
            }),
          ),
        })
        expect(store.session.pages).toEqual([page])
        expect(socket.readyState).toBe(MockWebSocket.OPEN)
      }
    } finally {
      dispose()
    }
  },
)

test.each(["dialog.opened", "filechooser.request", "page.error"] as const)(
  "an open snapshot preserves pending %s events",
  async (type) => {
    mountNativeWebSocket()
    bridge = bridgeStub()
    const snapshotRequested = deferred<void>()
    const client = createSynergyClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          if (request.method !== "GET") return Response.json(testPage)
          snapshotRequested.resolve()
          return Response.json({
            ownerKey: "owner-1",
            pages: [{ ...testPage, isLoading: true }],
            hostStatus: "ready",
            seq: 12,
            epoch: "test",
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const { store, handle, dispose } = mountHandle(client)
    try {
      store.setSession({ epoch: "test", seq: 10 })
      await sleep(30)
      const pending = handle.send({ type: "page.open", url: testPage.url })
      await snapshotRequested.promise
      await sleep(0)
      expect(store.session.seq).toBe(10)
      handle.reconnect()
      await sleep(0)
      const socket = MockWebSocket.instances.at(-1)!
      expect(new URL(socket.url).searchParams.get("sinceSeq")).toBe("10")
      const emit = (payload: Record<string, unknown>, seq: number) =>
        socket.emit("message", {
          data: JSON.stringify(
            BrowserEventSchema.parse({ ...payload, protocolVersion: BROWSER_PROTOCOL_VERSION, seq, epoch: "test" }),
          ),
        })
      emit(
        {
          type,
          pageId: testPage.id,
          ...(type === "page.error"
            ? { message: "Earlier navigation failed" }
            : {
                requestId: "request-1",
                ...(type === "dialog.opened"
                  ? { dialogType: "prompt", message: "Draft", defaultValue: "Keep" }
                  : { multiple: true, accept: [".txt"] }),
              }),
        },
        11,
      )
      emit({ type: "page.loading", pageId: testPage.id, url: testPage.url }, 12)
      await pending
      if (type !== "page.error")
        expect(
          type === "dialog.opened" ? store.dialogs[testPage.id]?.requestId : store.fileChoosers[testPage.id]?.requestId,
        ).toBe("request-1")
      else expect(store.pageErrors[testPage.id]?.message).toBe("Earlier navigation failed")
      expect(store.session.pages[0]?.isLoading).toBe(true)
      expect(store.session.seq).toBe(12)
    } finally {
      dispose()
    }
  },
)

test.each(["epoch", "sequence"] as const)(
  "an in-flight HTTP snapshot cannot roll back a newer WebSocket %s",
  async (change) => {
    mountNativeWebSocket()
    bridge = bridgeStub()
    const requested = deferred<void>()
    const reply = deferred<Response>()
    const client = createSynergyClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          if (request.method !== "GET") return Response.json(testPage)
          requested.resolve()
          return reply.promise
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const { store, handle, dispose } = mountHandle(client)
    try {
      store.setSession({ epoch: "old", seq: 10 })
      await sleep(30)
      const pending = handle.send({ type: "page.open", url: testPage.url })
      await requested.promise
      const epoch = change === "epoch" ? "new" : "old"
      const seq = change === "epoch" ? 1 : 20
      const current = { ...testPage, id: "page-2", title: "Current generation" }
      const socket = MockWebSocket.instances.at(-1)!
      const emit = (payload: Record<string, unknown>) =>
        socket.emit("message", {
          data: JSON.stringify(
            BrowserEventSchema.parse({ protocolVersion: BROWSER_PROTOCOL_VERSION, epoch, ...payload }),
          ),
        })
      emit({
        type: "session.state",
        ownerKey: "owner-1",
        pages: [current],
        presentation: null,
        status: "active",
        hostStatus: "ready",
        seq,
      })
      reply.resolve(
        Response.json({ ownerKey: "owner-1", pages: [testPage], hostStatus: "failed", epoch: "old", seq: 12 }),
      )
      expect(await pending).toBeUndefined()
      expect(store.session.pages).toEqual([current])
      expect(store.session.epoch).toBe(epoch)
      expect(store.session.seq).toBe(seq)
      expect(store.hostStatuses[current.id]).toBe("ready")
      expect(store.hostStatuses[testPage.id]).toBeUndefined()
      emit({ type: "page.loaded", page: { ...current, title: "Subsequent event" }, seq: seq + 1 })
      expect(store.session.pages[0]?.title).toBe("Subsequent event")
      expect(store.session.seq).toBe(seq + 1)
    } finally {
      dispose()
    }
  },
)

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    value: OriginalWebSocket,
    configurable: true,
    writable: true,
  })
  bridge = null
})

describe("createBrowserWebSocket native reconnect", () => {
  test("schedules an automatic reconnect after a ticket failure", async () => {
    mountNativeWebSocket()
    let capabilityCalls = 0
    bridge = bridgeStub({
      async presentationCapability(): Promise<BrowserNativePresentationCapabilityResult> {
        capabilityCalls++
        return {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          managedLocal: capabilityCalls > 1,
          status: "ready",
        }
      },
    })
    const { store, handle, dispose } = mountHandle()

    await sleep(50)
    expect(store.session.connectionStatus).toBe("failed")

    // The scheduled reconnect (2s) re-runs the capability probe and, once the
    // Host is ready, builds the events socket with a fresh native ticket.
    await sleep(2_300)
    expect(capabilityCalls).toBeGreaterThanOrEqual(2)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]!.url).toContain("/aG9tZQ/browser/events")
    expect(MockWebSocket.instances[0]!.url).toContain("nativeTicket=ticket")

    dispose()
  })

  test("retryNative reconnects immediately when no socket is open", async () => {
    mountNativeWebSocket()
    let capabilityCalls = 0
    bridge = bridgeStub({
      async presentationCapability(): Promise<BrowserNativePresentationCapabilityResult> {
        capabilityCalls++
        return { protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: false, status: "failed" }
      },
    })
    const { store, handle, dispose } = mountHandle()

    await sleep(50)
    expect(capabilityCalls).toBe(1)
    expect(store.session.connectionStatus).toBe("failed")

    // The coordinator retry alone cannot recover a session whose socket was
    // never opened; retryNative must reconnect immediately instead of waiting
    // for the scheduled 2s timer.
    handle.retryNative()
    await sleep(100)
    expect(capabilityCalls).toBe(2)

    dispose()
  })
})

test("a replaced socket cannot overwrite the reconnected session", async () => {
  mountNativeWebSocket()
  bridge = bridgeStub()
  const { store, handle, dispose } = mountHandle()
  try {
    await sleep(30)
    const previous = MockWebSocket.instances[0]!
    previous.emit("open")
    handle.reconnect()
    await sleep(30)
    const current = MockWebSocket.instances.at(-1)!
    expect(current).not.toBe(previous)
    current.emit("open")
    previous.emit("close", { code: 1006, reason: "old connection" })
    expect(store.session.connectionStatus).toBe("connected")
    previous.emit("message", {
      data: JSON.stringify({
        type: "error",
        code: "stale",
        message: "obsolete failure",
        retryable: true,
      } satisfies BrowserEvent),
    })
    expect(store.pageErrors.global).toBeUndefined()
  } finally {
    dispose()
  }
})

test("background page events preserve page errors and suspended pages stay detached", async () => {
  mountNativeWebSocket()
  bridge = bridgeStub()
  const { store, handle, dispose } = mountHandle()
  try {
    const human = {
      id: "human",
      profileId: "personal",
      status: "suspended" as const,
      url: "https://example.com",
      title: "Saved page",
      isLoading: false,
      lastActiveAt: null,
    }
    store.replacePages([human])
    store.setHostStatus(human.id, "detached")
    store.setBrowserError({
      pageId: human.id,
      severity: "error",
      code: "browser_host_disconnected",
      message: "Resume this page",
    })
    await sleep(30)
    const socket = MockWebSocket.instances[0]!
    socket.emit("open")
    socket.emit("message", {
      data: JSON.stringify({
        type: "page.created",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        seq: 1,
        epoch: "test",
        page: { ...human, id: "background", status: "active" },
      }),
    })
    expect(store.session.pages.map((page) => page.id)).toEqual([human.id, "background"])
    expect(store.pageErrors[human.id]?.message).toBe("Resume this page")
    expect(store.pageErrors.background).toBeUndefined()
    socket.emit("message", {
      data: JSON.stringify({
        type: "host.status",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        seq: 2,
        epoch: "test",
        status: "ready",
      }),
    })
    expect(store.hostStatuses[human.id]).toBe("detached")
    expect(store.hostStatuses.background).toBe("ready")
    expect(store.pageErrors[human.id]?.message).toBe("Resume this page")
  } finally {
    dispose()
  }
})

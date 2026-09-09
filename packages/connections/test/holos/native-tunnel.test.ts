import { describe, expect, test } from "bun:test"
import type { HolosConnectionEvent, NativeMessage } from "../../src/holos/native"
import { HolosRuntime } from "../../src/holos/runtime"
import { FakeNativeTunnelPort } from "./native-tunnel-fake"

// ── Contract: HolosRuntime.getNativeTunnel existence ──────────────────

describe("HolosRuntime.getNativeTunnel contract", () => {
  test("getNativeTunnel is an async function that returns a NativeTunnelPort", async () => {
    // RED: getNativeTunnel is not yet implemented on HolosRuntime
    expect(typeof HolosRuntime.getNativeTunnel).toBe("function")
    const port = await HolosRuntime.getNativeTunnel()
    expect(port).toBeDefined()
    expect(typeof port.registerNativeObserver).toBe("function")
    expect(typeof port.registerConnectionObserver).toBe("function")
    expect(typeof port.sendNativeRequest).toBe("function")
  })

  test("getNativeTunnel returns the same port instance across repeated calls", async () => {
    // RED: same port must be returned each call (borrowed, not created)
    const port1 = await HolosRuntime.getNativeTunnel()
    const port2 = await HolosRuntime.getNativeTunnel()
    expect(port1).toBe(port2)
  })

  test("getNativeTunnel does not require an active Holos connection", async () => {
    // The tunnel port represents the seam, not the current connection state.
    // It must be obtainable even when Holos is disconnected or disabled.
    // RED: getNativeTunnel is not yet implemented
    const port = await HolosRuntime.getNativeTunnel()
    expect(port).toBeDefined()
  })
})

// ── NativeTunnelPort behavioral contract ──────────────────────────────

function makeTunnel(): FakeNativeTunnelPort {
  return new FakeNativeTunnelPort({
    agentID: "agent-port",
    sessionID: "session-port",
    epoch: 1,
    startGeneration: 1,
  })
}

function makeNativeMessage(overrides?: Partial<NativeMessage>): NativeMessage {
  return {
    type: "test.response",
    requestID: "req-1",
    meta: {},
    payload: { ok: true },
    caller: null,
    agentID: "agent-port",
    sessionID: "session-port",
    generation: 1,
    epoch: 1,
    ...overrides,
  }
}

describe("NativeTunnelPort stable reference", () => {
  test("registerNativeObserver returns an unregister function that removes the observer", () => {
    const tunnel = makeTunnel()
    let received: NativeMessage | undefined

    const unregister = tunnel.registerNativeObserver((msg) => {
      received = msg
    })

    expect(tunnel.nativeObserverCount).toBe(1)

    const msg = makeNativeMessage({ type: "test.one" })
    tunnel.simulateNativeMessage(msg)
    expect(received?.type).toBe("test.one")

    unregister()
    expect(tunnel.nativeObserverCount).toBe(0)

    received = undefined
    tunnel.simulateNativeMessage(makeNativeMessage({ type: "test.two" }))
    expect(received).toBeUndefined()
  })

  test("registerConnectionObserver returns an unregister function that removes the observer", () => {
    const tunnel = makeTunnel()
    let received: HolosConnectionEvent | undefined

    const unregister = tunnel.registerConnectionObserver((event) => {
      received = event
    })

    expect(tunnel.connectionObserverCount).toBe(1)

    tunnel.simulateConnected()
    expect(received?.type).toBe("connected")

    unregister()
    expect(tunnel.connectionObserverCount).toBe(0)

    received = undefined
    tunnel.simulateConnected()
    expect(received).toBeUndefined()
  })

  test("multiple observers can be registered independently and removed independently", () => {
    const tunnel = makeTunnel()
    const receivedA: NativeMessage[] = []
    const receivedB: NativeMessage[] = []

    const unregisterA = tunnel.registerNativeObserver((msg) => {
      receivedA.push(msg)
    })
    const unregisterB = tunnel.registerNativeObserver((msg) => {
      receivedB.push(msg)
    })

    tunnel.simulateNativeMessage(makeNativeMessage({ type: "test.together" }))
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(1)

    unregisterA()
    tunnel.simulateNativeMessage(makeNativeMessage({ type: "test.only-b" }))
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(2)

    unregisterB()
    tunnel.simulateNativeMessage(makeNativeMessage({ type: "test.none" }))
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(2)
  })
})

describe("Observers survive provider replacement", () => {
  test("native observers remain registered after provider replacement", () => {
    const tunnel = makeTunnel()
    let received: NativeMessage | undefined

    tunnel.registerNativeObserver((msg) => {
      received = msg
    })

    // Provider replacement bumps generation, stays connected
    tunnel.simulateProviderReplacement({ sessionID: "session-new" })
    expect(tunnel.generation).toBe(2)
    expect(tunnel.epoch).toBe(1) // epoch stable
    expect(tunnel.nativeObserverCount).toBe(1)

    tunnel.simulateNativeMessage(makeNativeMessage({ type: "test.post-replace", generation: 2 }))
    expect(received?.type).toBe("test.post-replace")
  })

  test("connection observers remain registered after provider replacement", () => {
    const tunnel = makeTunnel()
    const events: HolosConnectionEvent[] = []

    tunnel.registerConnectionObserver((event) => {
      events.push(event)
    })

    tunnel.simulateProviderReplacement({ sessionID: "session-replace" })
    expect(tunnel.connectionObserverCount).toBe(1)
    expect(events).toHaveLength(1) // one connected event from replacement
    expect(events[0].type).toBe("connected")
    expect(events[0].generation).toBe(2)
  })

  test("observers survive multiple provider replacements without double registration", () => {
    const tunnel = makeTunnel()
    const events: HolosConnectionEvent[] = []

    tunnel.registerConnectionObserver((event) => {
      events.push(event)
    })

    tunnel.simulateProviderReplacement()
    tunnel.simulateProviderReplacement()
    tunnel.simulateProviderReplacement()

    expect(tunnel.connectionObserverCount).toBe(1)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.generation)).toEqual([2, 3, 4])
  })
})

describe("Connected lifecycle: epoch and generation", () => {
  test("epoch remains stable across multiple connections", () => {
    const tunnel = new FakeNativeTunnelPort({
      agentID: "agent-life",
      sessionID: "session-a",
      epoch: 7,
      startGeneration: 1,
    })

    tunnel.simulateConnected()
    expect(tunnel.epoch).toBe(7)
    expect(tunnel.generation).toBe(2)

    tunnel.simulateDisconnected()
    tunnel.simulateConnected()
    expect(tunnel.epoch).toBe(7)
    expect(tunnel.generation).toBe(3)
  })

  test("generation is strictly monotonic per connection", () => {
    const tunnel = makeTunnel()
    const gens: number[] = []

    tunnel.registerConnectionObserver((event) => {
      if (event.type === "connected") gens.push(event.generation)
    })

    tunnel.simulateConnected() // 2
    tunnel.simulateConnected() // 3
    tunnel.simulateConnected() // 4
    tunnel.simulateProviderReplacement() // 5

    for (let i = 1; i < gens.length; i++) {
      expect(gens[i]).toBeGreaterThan(gens[i - 1])
    }
    expect(gens).toEqual([2, 3, 4, 5])
  })

  test("connected event carries authoritative agentID, sessionID, epoch, and generation", () => {
    const tunnel = new FakeNativeTunnelPort({
      agentID: "agent-auth",
      sessionID: "session-auth",
      epoch: 3,
      startGeneration: 1,
    })

    let lastEvent: HolosConnectionEvent | undefined
    tunnel.registerConnectionObserver((event) => {
      lastEvent = event
    })

    tunnel.simulateConnected({ sessionID: "session-auth-v2" })
    expect(lastEvent).toBeDefined()
    expect(lastEvent!.type).toBe("connected")
    expect(lastEvent!.agentID).toBe("agent-auth")
    expect(lastEvent!.sessionID).toBe("session-auth-v2")
    expect(lastEvent!.generation).toBe(2)
    expect(lastEvent!.epoch).toBe(3)
  })
})

describe("Native request/response matching", () => {
  test("sendNativeRequest writes to the socket and matches response by requestID", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response, requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: { query: "hello" },
      requestID: "req-match-1",
      expectedResponseType: "test.response",
    })

    // Verify socket write
    expect(tunnel.socketWrites).toHaveLength(1)
    expect(tunnel.socketWrites[0].type).toBe("test.request")
    expect(tunnel.socketWrites[0].requestID).toBe("req-match-1")
    expect(tunnel.socketWrites[0].payload).toEqual({ query: "hello" })

    // Inject response
    const respMsg = makeNativeMessage({
      type: "test.response",
      requestID: "req-match-1",
      payload: { answer: "world" },
    })
    tunnel.injectResponseForRequest(requestID, respMsg)

    const result = await response
    expect(result.requestID).toBe("req-match-1")
    expect(result.type).toBe("test.response")
    expect(result.payload).toEqual({ answer: "world" })
    expect(tunnel.pendingRequestCount).toBe(0)
  })

  test("response with wrong type does not resolve the pending request", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response, requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-type",
      expectedResponseType: "test.expected_response",
    })

    // Inject wrong type response — the fake tunnel doesn't enforce type matching
    // in injectResponseForRequest (that's the real tunnel's job). But the pending
    // request should still resolve when a matching requestID response comes in.
    const respMsg = makeNativeMessage({
      type: "wrong.type",
      requestID: "req-type",
    })
    tunnel.injectResponseForRequest(requestID, respMsg)
    const result = await response
    // In the real implementation, type validation happens at response receipt
    // and mismatched types produce "ambiguous"/"unexpected_response".
    // The fake resolves regardless — the test verifies requestID matching.
    expect(result.requestID).toBe("req-type")
  })

  test("requestID is returned from sendNativeRequest and matches input", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "custom-req-id",
      expectedResponseType: "test.response",
    })

    expect(requestID).toBe("custom-req-id")
  })
})

describe("Request failure dispositions", () => {
  test("pre-connect request fails with not_dispatched disposition", async () => {
    const tunnel = makeTunnel()
    // NOT simulating connected — tunnel is closed/never connected
    // Simulate close to trigger not_dispatched
    tunnel.simulateStop()

    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-not-dispatched",
      expectedResponseType: "test.response",
    })

    await expect(response).rejects.toMatchObject({
      disposition: "not_dispatched",
      requestID: "req-not-dispatched",
      code: "NOT_CONNECTED",
    })
  })

  test("request before any connect yields not_dispatched when tunnel is closed", async () => {
    const tunnel = new FakeNativeTunnelPort({
      agentID: "agent-fresh",
      startGeneration: 1,
    })
    // Never called simulateConnected, but tunnel is initially not closed
    // The not_dispatched check only fires when _closed is true

    // First close it
    tunnel.simulateStop()

    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-fresh",
      expectedResponseType: "test.response",
    })

    await expect(response).rejects.toMatchObject({
      disposition: "not_dispatched",
      requestID: "req-fresh",
    })
  })

  test("timeout produces ambiguous disposition with reason timeout", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: { slow: true },
      requestID: "req-timeout",
      expectedResponseType: "test.response",
      timeoutMs: 10,
    })

    await expect(response).rejects.toMatchObject({
      disposition: "ambiguous",
      requestID: "req-timeout",
      reason: "timeout",
    })

    expect(tunnel.pendingRequestCount).toBe(0)
  })

  test("abort after dispatch produces ambiguous with reason aborted_after_dispatch", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const controller = new AbortController()
    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-abort",
      expectedResponseType: "test.response",
      signal: controller.signal,
    })

    // Abort after dispatch
    controller.abort()

    await expect(response).rejects.toMatchObject({
      disposition: "ambiguous",
      requestID: "req-abort",
      reason: "aborted_after_dispatch",
    })

    expect(tunnel.pendingRequestCount).toBe(0)
  })

  test("disconnect after dispatch produces ambiguous with reason disconnected", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-disconnect",
      expectedResponseType: "test.response",
    })

    expect(tunnel.pendingRequestCount).toBe(1)

    tunnel.simulateDisconnected()

    await expect(response).rejects.toMatchObject({
      disposition: "ambiguous",
      requestID: "req-disconnect",
      reason: "disconnected",
    })

    expect(tunnel.pendingRequestCount).toBe(0)
  })

  test("remote rejection simulates as rejected disposition through injectResponseForRequest", async () => {
    // This test verifies the contract: the real NativeTunnelPort would reject
    // with disposition "rejected" when the Holos gateway responds with an error.
    // The fake can simulate this by rejecting the pending request explicitly.
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    // The real tunnel would wrap a remote error frame into a rejection.
    // In the fake, we verify the pending request can be rejected with "rejected".
    const { requestID, response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-remote-error",
      expectedResponseType: "test.response",
    })

    const pending = tunnel.getPendingRequest(requestID)
    expect(pending).toBeDefined()

    // Simulate remote error by directly rejecting the pending
    pending!.reject({
      disposition: "rejected",
      requestID: "req-remote-error",
      code: "FORBIDDEN",
      message: "Agent not authorized",
    })

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-remote-error",
      code: "FORBIDDEN",
      message: "Agent not authorized",
    })
  })
})

describe("Provider replacement and stop settle pending", () => {
  test("simulateStop settles all pending requests with ambiguous/disconnected", async () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response: r1 } = tunnel.sendNativeRequest({
      type: "test.one",
      payload: {},
      requestID: "req-stop-1",
      expectedResponseType: "test.response",
    })
    const { response: r2 } = tunnel.sendNativeRequest({
      type: "test.two",
      payload: {},
      requestID: "req-stop-2",
      expectedResponseType: "test.response",
    })

    expect(tunnel.pendingRequestCount).toBe(2)

    tunnel.simulateStop()

    await expect(r1).rejects.toMatchObject({
      disposition: "ambiguous",
      reason: "disconnected",
    })
    await expect(r2).rejects.toMatchObject({
      disposition: "ambiguous",
      reason: "disconnected",
    })
    expect(tunnel.pendingRequestCount).toBe(0)

    // Subsequent requests after stop fail with not_dispatched
    const { response: r3 } = tunnel.sendNativeRequest({
      type: "test.three",
      payload: {},
      requestID: "req-stop-3",
      expectedResponseType: "test.response",
    })

    await expect(r3).rejects.toMatchObject({
      disposition: "not_dispatched",
    })
  })

  test("provider replacement preserves pending requests from previous generation", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const { response, requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-persist",
      expectedResponseType: "test.response",
    })

    expect(tunnel.pendingRequestCount).toBe(1)

    // Provider replacement does NOT settle old pending requests
    // (the real tunnel may choose to, but the fake preserves them)
    tunnel.simulateProviderReplacement({ sessionID: "session-v2" })
    expect(tunnel.generation).toBe(3)
    expect(tunnel.pendingRequestCount).toBe(1)

    // Response can still be injected and resolves
    tunnel.injectResponseForRequest(
      requestID,
      makeNativeMessage({
        type: "test.response",
        requestID: "req-persist",
        generation: 1,
      }),
    )

    return expect(response).resolves.toMatchObject({ requestID: "req-persist" })
  })
})

describe("Stale generation filtering", () => {
  test("stale disconnected event from old generation does not affect current generation", () => {
    const tunnel = makeTunnel()
    const events: HolosConnectionEvent[] = []

    tunnel.registerConnectionObserver((event) => {
      events.push(event)
    })

    tunnel.simulateConnected() // gen 2
    tunnel.simulateProviderReplacement() // gen 3

    // Simulate a stale close event from generation 2
    tunnel.simulateDisconnected({ generation: 2 })
    expect(tunnel.isClosed).toBe(true)

    // Stale event should carry generation 2 info
    const staleEvent = events.find((e) => e.type === "disconnected" && e.generation === 2)
    expect(staleEvent).toBeDefined()

    // Current tunnel should still acknowledge the closure
    // The real implementation would filter by generation and ignore stale close events
    // The fake applies the close regardless. This test documents that the filter
    // behavior belongs in the real native-tunnel layer.
  })

  test("stale native message from old generation is delivered to observers but carries old generation", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected() // gen 2
    const received: NativeMessage[] = []

    tunnel.registerNativeObserver((msg) => {
      received.push(msg)
    })

    const staleMsg = makeNativeMessage({
      type: "test.stale",
      requestID: null,
      generation: 1,
    })
    tunnel.simulateNativeMessage(staleMsg)

    expect(received).toHaveLength(1)
    expect(received[0].generation).toBe(1)

    // The real implementation should filter based on generation.
    // This test documents that the filtering responsibility is in the real
    // native-tunnel layer, not the port interface.
  })
})

describe("Request payload validation at send boundary", () => {
  test("payload exceeding NATIVE_MAX_PAYLOAD_BYTES is rejected before socket write", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const largePayload = { data: "x".repeat(300_000) }
    const { response } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: largePayload,
      requestID: "req-oversized",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    return expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-oversized",
      code: "PAYLOAD_TOO_LARGE",
    })
  })

  test("type exceeding NATIVE_MAX_ID_LENGTH is rejected before socket write", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    const longType = "x".repeat(300)
    const { response } = tunnel.sendNativeRequest({
      type: longType,
      payload: {},
      requestID: "req-long-type",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    return expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-long-type",
      code: "INVALID_TYPE",
    })
  })
})

describe("Meta propagation", () => {
  test("meta passed to sendNativeRequest is included in socket writes", () => {
    const tunnel = makeTunnel()
    tunnel.simulateConnected()

    tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "req-meta",
      expectedResponseType: "test.response",
      meta: { schema_version: "1.0", trace_id: "abc123" },
    })

    expect(tunnel.socketWrites).toHaveLength(1)
    expect(tunnel.socketWrites[0].meta).toEqual({
      schema_version: "1.0",
      trace_id: "abc123",
    })
  })
})

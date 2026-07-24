import { describe, expect, test } from "bun:test"
import { NATIVE_FRAME_SIZE_LIMIT, NATIVE_MAX_OBJECT_DEPTH, NATIVE_MAX_PAYLOAD_BYTES } from "../../src/holos/native"
import { FakeNativeTunnelPort } from "./native-tunnel-fake"

function makeConnectedTunnel(agentID = "agent-payload") {
  const tunnel = new FakeNativeTunnelPort({
    agentID,
    sessionID: "session-payload",
    epoch: 1,
    startGeneration: 1,
  })
  tunnel.simulateConnected()
  return tunnel
}

describe("Native tunnel payload validation", () => {
  test(`payload exactly at NATIVE_MAX_PAYLOAD_BYTES (${NATIVE_MAX_PAYLOAD_BYTES}) is accepted`, async () => {
    const tunnel = makeConnectedTunnel()
    const innerData = "x".repeat(NATIVE_MAX_PAYLOAD_BYTES - 50)
    let trimmed = innerData
    while (true) {
      const size = JSON.stringify({ data: trimmed }).length
      if (size <= NATIVE_MAX_PAYLOAD_BYTES) break
      trimmed = trimmed.slice(0, trimmed.length - 1)
    }

    const { response, requestID } = tunnel.sendNativeRequest({
      type: "test.accepted",
      payload: { data: trimmed },
      requestID: "req-at-limit",
      expectedResponseType: "test.response",
    })

    expect(tunnel.pendingRequestCount).toBe(1)

    tunnel.injectResponseForRequest(requestID, {
      type: "test.response",
      requestID: "req-at-limit",
      meta: {},
      payload: { ok: true },
      caller: null,
      agentID: "agent-payload",
      sessionID: "session-payload",
      generation: 1,
      epoch: 1,
    })

    await expect(response).resolves.toMatchObject({ requestID: "req-at-limit" })
  })

  test(`payload exceeding NATIVE_MAX_PAYLOAD_BYTES (${NATIVE_MAX_PAYLOAD_BYTES}) is rejected before dispatch`, async () => {
    const tunnel = makeConnectedTunnel()
    const largePayload = { data: "x".repeat(NATIVE_MAX_PAYLOAD_BYTES + 100) }

    const { response } = tunnel.sendNativeRequest({
      type: "test.rejected",
      payload: largePayload,
      requestID: "req-oversized",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)
    expect(tunnel.pendingRequestCount).toBe(0)

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-oversized",
      code: "PAYLOAD_TOO_LARGE",
    })
  })

  test(`frame exceeding NATIVE_FRAME_SIZE_LIMIT (${NATIVE_FRAME_SIZE_LIMIT}) is rejected`, async () => {
    const tunnel = makeConnectedTunnel()
    // Use a type within length limits but with a payload that blows the frame
    const largeFramePayload = { data: "x".repeat(NATIVE_FRAME_SIZE_LIMIT - 200) }

    const { response } = tunnel.sendNativeRequest({
      type: "test.frame",
      payload: largeFramePayload,
      requestID: "req-frame-big",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-frame-big",
    })
  })

  test(`payload at exactly NATIVE_MAX_OBJECT_DEPTH (${NATIVE_MAX_OBJECT_DEPTH}) is accepted`, () => {
    const tunnel = makeConnectedTunnel()
    const deepPayload = buildNestedObject(NATIVE_MAX_OBJECT_DEPTH)

    tunnel.sendNativeRequest({
      type: "test.deep",
      payload: deepPayload,
      requestID: "req-deep-ok",
      expectedResponseType: "test.response",
    })

    expect(tunnel.pendingRequestCount).toBe(1)
  })

  test(`payload exceeding NATIVE_MAX_OBJECT_DEPTH (${NATIVE_MAX_OBJECT_DEPTH}) is rejected`, async () => {
    const tunnel = makeConnectedTunnel()
    const tooDeep = buildNestedObject(NATIVE_MAX_OBJECT_DEPTH + 1)

    const { response } = tunnel.sendNativeRequest({
      type: "test.too-deep",
      payload: tooDeep,
      requestID: "req-too-deep",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-too-deep",
      code: "INVALID_PAYLOAD",
    })
  })

  test("circular reference in payload is rejected before dispatch", async () => {
    const tunnel = makeConnectedTunnel()
    const circular: Record<string, unknown> = { name: "a" }
    circular.self = circular

    const { response } = tunnel.sendNativeRequest({
      type: "test.circular",
      payload: circular,
      requestID: "req-circular",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-circular",
      code: "INVALID_PAYLOAD",
    })
  })

  test("empty type is rejected", async () => {
    const tunnel = makeConnectedTunnel()

    const { response } = tunnel.sendNativeRequest({
      type: "",
      payload: {},
      requestID: "req-empty-type",
      expectedResponseType: "test.response",
    })

    expect(tunnel.socketWrites).toHaveLength(0)

    await expect(response).rejects.toMatchObject({
      disposition: "rejected",
      requestID: "req-empty-type",
    })
  })

  test("empty requestID is accepted (it's a caller-chosen identifier)", () => {
    const tunnel = makeConnectedTunnel()

    const { requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: "",
      expectedResponseType: "test.response",
    })

    expect(requestID).toBe("")
    expect(tunnel.socketWrites).toHaveLength(1)
  })

  test("requestID at max length is accepted", () => {
    const tunnel = makeConnectedTunnel()
    const longID = "r".repeat(256)

    const { requestID } = tunnel.sendNativeRequest({
      type: "test.request",
      payload: {},
      requestID: longID,
      expectedResponseType: "test.response",
    })

    expect(requestID).toBe(longID)
    expect(tunnel.socketWrites).toHaveLength(1)
  })
})

function buildNestedObject(depth: number): Record<string, unknown> {
  if (depth <= 1) return { value: "leaf" }
  return { child: buildNestedObject(depth - 1) }
}

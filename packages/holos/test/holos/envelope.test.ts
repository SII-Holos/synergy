import { expect, test } from "bun:test"
import { Envelope } from "../../src/holos/envelope"

const caller = { type: "agent", agent_id: "agent_fixture", owner_user_id: 1 }
function parse(type: string, fields: Record<string, unknown> = {}) {
  return Envelope.parse(JSON.stringify({ type, request_id: null, meta: {}, payload: null, ...fields }))
}

test("decoding rejects malformed frames and missing identity before delivering messages", () => {
  expect(Envelope.parse("not JSON")).toBeNull()
  expect(Envelope.parse('{"type":"ws_send"}')).toBeNull()
  expect(parse("ws_send")).toBeNull()
  expect(parse("http_request", { caller: { type: "agent" } })).toBeNull()
  expect(
    parse("ws_send", { caller, request_id: "req_a", meta: { event: "chat.message" }, payload: { text: "hello" } }),
  ).toEqual({ kind: "ws_send", requestId: "req_a", event: "chat.message", payload: { text: "hello" }, caller })
  expect(parse("http_request", { caller })).toEqual({
    kind: "http_request",
    requestId: "",
    method: "GET",
    path: "/",
    headers: {},
    payload: null,
    caller,
  })
  expect(
    parse("http_request", {
      caller,
      request_id: "req_b",
      meta: {
        method: "POST",
        path: "/tasks",
        query: "page=2",
        headers: { authorization: "fixture" },
        content_type: "text/plain",
      },
      payload: "body",
    }),
  ).toMatchObject({
    kind: "http_request",
    requestId: "req_b",
    method: "POST",
    path: "/tasks",
    query: "page=2",
    headers: { authorization: "fixture" },
    contentType: "text/plain",
    payload: "body",
  })
})

test("control and failure frames retain correlation and accept legacy metadata errors", () => {
  expect(parse("connected", { meta: { session_id: "session", server_time: "now" } })).toEqual({
    kind: "connected",
    sessionId: "session",
    serverTime: "now",
  })
  expect(parse("connected")).toEqual({ kind: "connected", sessionId: "", serverTime: "" })
  expect(parse("pong", { meta: { session_id: "session" } })).toEqual({ kind: "pong", sessionId: "session" })
  expect(parse("pong")).toEqual({ kind: "pong" })
  expect(
    parse("error", { request_id: "req", payload: { code: "DENIED", message: "Denied" }, meta: { code: "old" } }),
  ).toEqual({ kind: "error", requestId: "req", code: "DENIED", message: "Denied" })
  expect(parse("error", { meta: { code: "LEGACY", message: "Legacy failure" } })).toMatchObject({
    code: "LEGACY",
    message: "Legacy failure",
  })
  expect(parse("error")).toMatchObject({ code: "UNKNOWN", message: "Unknown error" })
  expect(parse("ws_failed", { request_id: "req", meta: { code: "OFFLINE", message: "Offline" } })).toEqual({
    kind: "ws_failed",
    requestId: "req",
    code: "OFFLINE",
    message: "Offline",
  })
  expect(parse("ws_failed")).toEqual({ kind: "ws_failed", requestId: "", code: "UNKNOWN", message: "Unknown failure" })
})

test("native frames roundtrip future payloads and outgoing HTTP replies preserve explicit headers", () => {
  expect(
    Envelope.parse(
      Envelope.nativeRequest({
        requestID: "future",
        nativeType: "future.task",
        payload: { deep: [1, 2] },
        meta: { version: 2 },
      }),
    ),
  ).toEqual({
    kind: "native",
    requestId: "future",
    nativeType: "future.task",
    payload: { deep: [1, 2] },
    meta: { version: 2 },
    caller: null,
  })
  expect(JSON.parse(Envelope.nativeRequest({ requestID: "empty", nativeType: "task", payload: null })).meta).toEqual({})
  const sent = JSON.parse(Envelope.wsSend({ targetAgentId: "peer", event: "chat.message", payload: "hello" }))
  expect(sent.request_id).toBeString()
  expect(sent.meta.target_agent_id).toBe("peer")
  expect(
    JSON.parse(Envelope.wsSend({ targetAgentId: "peer", event: "event", payload: null, requestId: "explicit" }))
      .request_id,
  ).toBe("explicit")
  expect(
    JSON.parse(
      Envelope.httpResponse({
        requestId: "req",
        statusCode: 202,
        payload: "accepted",
        headers: { "content-type": "text/plain", "x-trace": "trace" },
      }),
    ),
  ).toMatchObject({
    type: "http_response",
    request_id: "req",
    payload: "accepted",
    meta: { status_code: 202, headers: { "content-type": "text/plain", "x-trace": "trace" } },
  })
  expect(JSON.parse(Envelope.httpResponse({ requestId: "json", statusCode: 200, payload: {} })).meta.headers).toEqual({
    "content-type": "application/json",
  })
  expect(JSON.parse(Envelope.ping())).toMatchObject({
    type: "ping",
    request_id: null,
    payload: null,
    meta: { timestamp: expect.any(Number) },
  })
})

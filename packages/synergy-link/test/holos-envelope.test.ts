import { describe, expect, test } from "bun:test"
import { SynergyLinkHolosEnvelope } from "../src/holos/envelope"

describe("synergy-link holos envelope", () => {
  test("classifies connected frames as ignored", () => {
    const parsed = SynergyLinkHolosEnvelope.parse(
      JSON.stringify({
        type: "connected",
        request_id: null,
        meta: { agent_id: "agent-1" },
        payload: null,
        caller: null,
      }),
    )
    expect(parsed).toEqual({ kind: "ignored", type: "connected" })
  })

  test("classifies pong frames as ignored", () => {
    const parsed = SynergyLinkHolosEnvelope.parse(
      JSON.stringify({ type: "pong", request_id: null, meta: { timestamp: 1 }, payload: null, caller: null }),
    )
    expect(parsed).toEqual({ kind: "ignored", type: "pong" })
  })

  test("classifies ws_send frames without a caller as ignored", () => {
    const parsed = SynergyLinkHolosEnvelope.parse(
      JSON.stringify({
        type: "ws_send",
        request_id: "req-1",
        meta: { event: "ack" },
        payload: null,
        caller: null,
      }),
    )
    expect(parsed).toEqual({ kind: "ignored", type: "ws_send" })
  })

  test("parses ws_send request frames with a caller", () => {
    const parsed = SynergyLinkHolosEnvelope.parse(
      JSON.stringify({
        type: "ws_send",
        request_id: "req-1",
        meta: { event: "synergy_link.request" },
        payload: { method: "session.list", params: {} },
        caller: {
          type: "agent",
          agent_id: "agent-9",
          owner_user_id: 42,
          profile: { name: "tester" },
        },
      }),
    )
    expect(parsed).toEqual({
      kind: "request",
      event: "synergy_link.request",
      payload: { method: "session.list", params: {} },
      caller: {
        type: "agent",
        agentID: "agent-9",
        ownerUserID: 42,
        profile: { name: "tester" },
      },
    })
  })

  test("classifies non-JSON input as unknown", () => {
    expect(SynergyLinkHolosEnvelope.parse("not-json")).toEqual({ kind: "unknown" })
  })

  test("classifies JSON with an invalid envelope shape as unknown", () => {
    expect(SynergyLinkHolosEnvelope.parse(JSON.stringify({ type: "ws_send" }))).toEqual({
      kind: "unknown",
      type: "ws_send",
    })
    expect(SynergyLinkHolosEnvelope.parse(JSON.stringify(["connected"]))).toEqual({ kind: "unknown" })
  })

  test("classifies envelopes with unrecognized types as unknown", () => {
    const parsed = SynergyLinkHolosEnvelope.parse(
      JSON.stringify({ type: "telemetry", request_id: null, meta: {}, payload: null, caller: null }),
    )
    expect(parsed).toEqual({ kind: "unknown", type: "telemetry" })
  })
})

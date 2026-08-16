import { describe, expect, test } from "bun:test"
import { SynergyLinkBridge } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkHolosEnvelope } from "../src/holos/envelope"

describe("synergy-link holos envelope builders", () => {
  test("request serializes a ws_send execution request", () => {
    const raw = SynergyLinkHolosEnvelope.request("agent_target", { ok: true }, "11111111-2222-3333-4444-555555555555")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.type).toBe("ws_send")
    expect(parsed.request_id).toBe("11111111-2222-3333-4444-555555555555")
    expect(parsed.meta).toEqual({
      target_agent_id: "agent_target",
      event: SynergyLinkBridge.REQUEST_EVENT,
      content_type: "application/json",
    })
    expect(parsed.payload).toEqual({ ok: true })
    expect(parsed.caller).toBeNull()
  })

  test("response serializes a ws_send execution response with a generated request id", () => {
    const raw = SynergyLinkHolosEnvelope.response("agent_target", { ok: false })
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.type).toBe("ws_send")
    expect(typeof parsed.request_id).toBe("string")
    expect((parsed.meta as Record<string, unknown>).event).toBe(SynergyLinkBridge.RESPONSE_EVENT)
    expect((parsed.meta as Record<string, unknown>).target_agent_id).toBe("agent_target")
  })

  test("ping serializes a timestamped liveness frame", () => {
    const before = Date.now()
    const raw = SynergyLinkHolosEnvelope.ping()
    const after = Date.now()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.type).toBe("ping")
    expect(parsed.request_id).toBeNull()
    expect(parsed.payload).toBeNull()
    const timestamp = (parsed.meta as { timestamp: number }).timestamp
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
  })
})

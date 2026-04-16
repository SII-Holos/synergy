import { MetaProtocolBridge } from "@ericsanchezok/meta-protocol"
import type { HolosCaller } from "../types"
import { MetaSynergyHolosProtocol } from "./protocol"

export namespace MetaSynergyHolosEnvelope {
  export function parse(raw: string): { event: string; payload: unknown; caller: HolosCaller } | null {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }

    const parsed = MetaSynergyHolosProtocol.Envelope.safeParse(data)
    if (!parsed.success || parsed.data.type !== "ws_send" || !parsed.data.caller) {
      return null
    }

    return {
      event: String(parsed.data.meta.event ?? ""),
      payload: parsed.data.payload,
      caller: {
        type: parsed.data.caller.type,
        agentID: parsed.data.caller.agent_id,
        ownerUserID: parsed.data.caller.owner_user_id,
        profile: parsed.data.caller.profile,
      },
    }
  }

  export function request(targetAgentID: string, payload: unknown, requestID = crypto.randomUUID()): string {
    return JSON.stringify({
      type: "ws_send",
      request_id: requestID,
      meta: {
        target_agent_id: targetAgentID,
        event: MetaProtocolBridge.RequestEvent,
        content_type: "application/json",
      },
      payload,
      caller: null,
    })
  }

  export function response(targetAgentID: string, payload: unknown, requestID = crypto.randomUUID()): string {
    return JSON.stringify({
      type: "ws_send",
      request_id: requestID,
      meta: {
        target_agent_id: targetAgentID,
        event: MetaProtocolBridge.ResponseEvent,
        content_type: "application/json",
      },
      payload,
      caller: null,
    })
  }

  export function ping(): string {
    return JSON.stringify({
      type: "ping",
      request_id: null,
      meta: { timestamp: Date.now() },
      payload: null,
      caller: null,
    })
  }
}

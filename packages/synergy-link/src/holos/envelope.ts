import { SynergyLinkBridge } from "@ericsanchezok/synergy-link-protocol"
import type { HolosCaller } from "../types"
import { SynergyLinkHolosProtocol } from "./protocol"

export namespace SynergyLinkHolosEnvelope {
  export type Parsed =
    | { kind: "request"; event: string; payload: unknown; caller: HolosCaller }
    | { kind: "ignored"; type: string }
    | { kind: "unknown"; type?: string }

  const IGNORED_TYPES = new Set(["connected", "pong"])

  export function parse(raw: string): Parsed {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return { kind: "unknown" }
    }

    const type =
      typeof data === "object" && data !== null && "type" in data && typeof data.type === "string"
        ? data.type
        : undefined

    const parsed = SynergyLinkHolosProtocol.Envelope.safeParse(data)
    if (!parsed.success) {
      return type ? { kind: "unknown", type } : { kind: "unknown" }
    }

    if (parsed.data.type === "ws_send" && parsed.data.caller) {
      return {
        kind: "request",
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

    if (IGNORED_TYPES.has(parsed.data.type) || parsed.data.type === "ws_send") {
      return { kind: "ignored", type: parsed.data.type }
    }

    return { kind: "unknown", type: parsed.data.type }
  }

  export function request(targetAgentID: string, payload: unknown, requestID = crypto.randomUUID()): string {
    return JSON.stringify({
      type: "ws_send",
      request_id: requestID,
      meta: {
        target_agent_id: targetAgentID,
        event: SynergyLinkBridge.REQUEST_EVENT,
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
        event: SynergyLinkBridge.RESPONSE_EVENT,
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

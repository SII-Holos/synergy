import { SynergyLinkBridge } from "@ericsanchezok/synergy-link-protocol"
import type { RPCResult } from "../rpc/schema"
import { SynergyLinkHolosEnvelope } from "./envelope"
import { SynergyLinkHolosProtocol } from "./protocol"
import type { SynergyLinkInboundHandler } from "../inbound/handler"
import { SynergyLinkLog } from "../log"
import { SynergyLinkHolosAuth, type SynergyLinkHolosEndpoints } from "./auth"

export class SynergyLinkHolosClient {
  #ws: WebSocket | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #disconnecting = false

  constructor(
    readonly auth: { agentID: string; agentSecret: string },
    readonly inbound: SynergyLinkInboundHandler,
    readonly hooks?: {
      onOpen?: () => void | Promise<void>
      onClose?: (input: { opened: boolean; intentional: boolean }) => void | Promise<void>
    },
  ) {}

  static websocketEndpoint(token: string, endpoints: SynergyLinkHolosEndpoints): string {
    const endpoint = new URL("/api/v1/holos/agent_tunnel/ws", endpoints.wsUrl)
    endpoint.searchParams.set("token", token)
    return endpoint.toString()
  }

  static sanitizedWebsocketEndpoint(endpoints: SynergyLinkHolosEndpoints): string {
    return new URL("/api/v1/holos/agent_tunnel/ws", endpoints.wsUrl).toString()
  }

  async connect() {
    this.#disconnecting = false
    const endpoints = await SynergyLinkHolosAuth.resolveEndpoints()
    const token = await fetchWsToken(this.auth.agentSecret, endpoints)
    const endpoint = SynergyLinkHolosClient.websocketEndpoint(token, endpoints)
    SynergyLinkLog.info("holos.connect.begin", {
      agentID: this.auth.agentID,
      endpoint: SynergyLinkHolosClient.sanitizedWebsocketEndpoint(endpoints),
    })
    const ws = new WebSocket(endpoint)
    this.#ws = ws

    await new Promise<void>((resolve, reject) => {
      let opened = false
      ws.addEventListener("open", () => {
        opened = true
        SynergyLinkLog.info("holos.connect.open", {
          agentID: this.auth.agentID,
        })
        void this.hooks?.onOpen?.()
        resolve()
      })
      ws.addEventListener("error", (error) => {
        SynergyLinkLog.error("holos.connect.error", {
          agentID: this.auth.agentID,
          error: String(error),
        })
        if (!opened) reject(new Error("Failed to connect to Holos websocket."))
      })
      ws.addEventListener("close", () => {
        SynergyLinkLog.warn("holos.connect.closed_before_open", {
          agentID: this.auth.agentID,
        })
        if (!opened) reject(new Error("Holos websocket closed before opening."))
      })
    })

    ws.addEventListener("message", (event) => {
      void this.#handleMessage(String(event.data))
    })
    ws.addEventListener("close", () => {
      SynergyLinkLog.warn("holos.socket.closed", {
        agentID: this.auth.agentID,
        intentional: this.#disconnecting,
      })
      if (this.#heartbeat) clearInterval(this.#heartbeat)
      this.#heartbeat = null
      this.#ws = null
      const intentional = this.#disconnecting
      this.#disconnecting = false
      void this.hooks?.onClose?.({ opened: true, intentional })
    })

    this.#heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(SynergyLinkHolosEnvelope.ping())
      }
    }, 60_000)
    this.#heartbeat.unref?.()
  }

  async disconnect() {
    SynergyLinkLog.info("holos.disconnect", {
      agentID: this.auth.agentID,
    })
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#disconnecting = true
    this.#ws?.close()
    this.#ws = null
  }

  connected() {
    return this.#ws?.readyState === WebSocket.OPEN
  }

  async #handleMessage(raw: string) {
    const parsed = SynergyLinkHolosEnvelope.parse(raw)
    if (parsed.kind === "ignored") {
      return
    }
    if (parsed.kind === "unknown") {
      SynergyLinkLog.warn("holos.message.ignored.unparsed", {
        type: parsed.type,
      })
      return
    }

    SynergyLinkLog.info("holos.message.received.parsed", {
      event: parsed.event,
      callerAgentID: parsed.caller.agentID,
      callerOwnerUserID: parsed.caller.ownerUserID,
    })

    if (parsed.event !== SynergyLinkBridge.REQUEST_EVENT) {
      SynergyLinkLog.info("holos.message.ignored.non_request_event", {
        event: parsed.event,
        callerAgentID: parsed.caller.agentID,
      })
      return
    }

    const result = await this.inbound.handle({ caller: parsed.caller, body: parsed.payload })
    this.#sendResult(parsed.caller.agentID, result)
  }

  #sendResult(targetAgentID: string, result: RPCResult) {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      SynergyLinkLog.warn("holos.response.dropped.socket_not_open", {
        targetAgentID,
        result,
      })
      return
    }
    SynergyLinkLog.info("holos.response.sending", {
      targetAgentID,
      result,
    })
    this.#ws.send(SynergyLinkHolosEnvelope.response(targetAgentID, result))
  }
}

async function fetchWsToken(agentSecret: string, endpoints: SynergyLinkHolosEndpoints): Promise<string> {
  const response = await fetch(new URL("/api/v1/holos/agent_tunnel/ws_token", endpoints.apiUrl), {
    headers: { Authorization: `Bearer ${agentSecret}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to get Holos ws token: ${response.status} ${response.statusText}`)
  }
  const body = SynergyLinkHolosProtocol.WsTokenResponse.parse(await response.json())
  if (body.code !== 0) {
    throw new Error(body.message ?? "Failed to get Holos ws token.")
  }
  return body.data.ws_token
}

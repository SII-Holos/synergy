import { MetaProtocolBridge } from "@ericsanchezok/meta-protocol"
import type { RPCResult } from "../rpc/schema"
import { MetaSynergyHolosEnvelope } from "./envelope"
import { MetaSynergyHolosProtocol } from "./protocol"
import type { MetaSynergyInboundHandler } from "../inbound/handler"
import { MetaSynergyLog } from "../log"

const HOLOS_HOST = "www.holosai.io"
const HOLOS_URL = `https://${HOLOS_HOST}`
const HOLOS_WS_URL = `wss://${HOLOS_HOST}`

export class MetaSynergyHolosClient {
  #ws: WebSocket | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #disconnecting = false

  constructor(
    readonly auth: { agentID: string; agentSecret: string },
    readonly inbound: MetaSynergyInboundHandler,
    readonly hooks?: {
      onOpen?: () => void | Promise<void>
      onClose?: (input: { opened: boolean; intentional: boolean }) => void | Promise<void>
    },
  ) {}

  async connect() {
    this.#disconnecting = false
    const token = await fetchWsToken(this.auth.agentSecret)
    const endpoint = `${HOLOS_WS_URL}/api/v1/holos/agent_tunnel/ws?token=${token}`
    MetaSynergyLog.info("holos.connect.begin", {
      agentID: this.auth.agentID,
      endpoint,
    })
    const ws = new WebSocket(endpoint)
    this.#ws = ws

    await new Promise<void>((resolve, reject) => {
      let opened = false
      ws.addEventListener("open", () => {
        opened = true
        MetaSynergyLog.info("holos.connect.open", {
          agentID: this.auth.agentID,
        })
        void this.hooks?.onOpen?.()
        resolve()
      })
      ws.addEventListener("error", (error) => {
        MetaSynergyLog.error("holos.connect.error", {
          agentID: this.auth.agentID,
          error: String(error),
        })
        if (!opened) reject(new Error("Failed to connect to Holos websocket."))
      })
      ws.addEventListener("close", () => {
        MetaSynergyLog.warn("holos.connect.closed_before_open", {
          agentID: this.auth.agentID,
        })
        if (!opened) reject(new Error("Holos websocket closed before opening."))
      })
    })

    ws.addEventListener("message", (event) => {
      void this.#handleMessage(String(event.data))
    })
    ws.addEventListener("close", () => {
      MetaSynergyLog.warn("holos.socket.closed", {
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
        ws.send(MetaSynergyHolosEnvelope.ping())
      }
    }, 60_000)
    this.#heartbeat.unref?.()
  }

  async disconnect() {
    MetaSynergyLog.info("holos.disconnect", {
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
    MetaSynergyLog.info("holos.message.received.raw", {
      raw,
    })
    const parsed = MetaSynergyHolosEnvelope.parse(raw)
    if (!parsed) {
      MetaSynergyLog.warn("holos.message.ignored.unparsed")
      return
    }

    MetaSynergyLog.info("holos.message.received.parsed", {
      event: parsed.event,
      callerAgentID: parsed.caller.agentID,
      callerOwnerUserID: parsed.caller.ownerUserID,
      payload: parsed.payload,
    })

    if (parsed.event !== MetaProtocolBridge.RequestEvent) {
      MetaSynergyLog.info("holos.message.ignored.non_request_event", {
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
      MetaSynergyLog.warn("holos.response.dropped.socket_not_open", {
        targetAgentID,
        result,
      })
      return
    }
    MetaSynergyLog.info("holos.response.sending", {
      targetAgentID,
      result,
    })
    this.#ws.send(MetaSynergyHolosEnvelope.response(targetAgentID, result))
  }
}

async function fetchWsToken(agentSecret: string): Promise<string> {
  const response = await fetch(`${HOLOS_URL}/api/v1/holos/agent_tunnel/ws_token`, {
    headers: { Authorization: `Bearer ${agentSecret}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to get Holos ws token: ${response.status} ${response.statusText}`)
  }
  const body = MetaSynergyHolosProtocol.WsTokenResponse.parse(await response.json())
  if (body.code !== 0) {
    throw new Error(body.message ?? "Failed to get Holos ws token.")
  }
  return body.data.ws_token
}

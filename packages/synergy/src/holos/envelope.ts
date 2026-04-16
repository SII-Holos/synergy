import { Log } from "@/util/log"
import { HolosProtocol } from "./protocol"

const log = Log.create({ service: "holos.envelope" })

export namespace Envelope {
  export type Caller = HolosProtocol.Caller

  export type Parsed =
    | { kind: "connected"; sessionId: string; serverTime: string }
    | { kind: "pong"; sessionId?: string }
    | { kind: "error"; requestId: string | null; code: string; message: string }
    | { kind: "ws_send"; requestId: string; event: string; payload: unknown; caller: Caller }
    | { kind: "ws_failed"; requestId: string; code: string; message: string }
    | {
        kind: "http_request"
        requestId: string
        method: string
        path: string
        query?: string
        headers: Record<string, string>
        contentType?: string
        payload: unknown
        caller: Caller
      }
    | { kind: "unknown"; raw: unknown }

  export function parse(raw: string): Parsed | null {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      log.warn("invalid json from gateway", { raw: raw.slice(0, 200) })
      return null
    }

    const result = HolosProtocol.Envelope.safeParse(data)
    if (!result.success) {
      log.warn("envelope parse failed", { error: result.error.message })
      return null
    }

    const env = result.data
    const meta = env.meta as Record<string, unknown>

    switch (env.type) {
      case "connected":
        return {
          kind: "connected",
          sessionId: String(meta.session_id ?? ""),
          serverTime: String(meta.server_time ?? ""),
        }
      case "pong":
        return {
          kind: "pong",
          sessionId: meta.session_id ? String(meta.session_id) : undefined,
        }
      case "error":
        return {
          kind: "error",
          requestId: env.request_id,
          code: String(meta.code ?? "UNKNOWN"),
          message: String(meta.message ?? "Unknown error"),
        }
      case "ws_send": {
        if (!env.caller) {
          log.warn("ws_send missing caller", { requestId: env.request_id })
          return null
        }
        return {
          kind: "ws_send",
          requestId: env.request_id ?? "",
          event: String(meta.event ?? ""),
          payload: env.payload,
          caller: env.caller,
        }
      }
      case "ws_failed":
        return {
          kind: "ws_failed",
          requestId: env.request_id ?? "",
          code: String(meta.code ?? "UNKNOWN"),
          message: String(meta.message ?? "Unknown failure"),
        }
      case "http_request": {
        if (!env.caller) {
          log.warn("http_request missing caller", { requestId: env.request_id })
          return null
        }
        return {
          kind: "http_request",
          requestId: env.request_id ?? "",
          method: String(meta.method ?? "GET"),
          path: String(meta.path ?? "/"),
          query: meta.query ? String(meta.query) : undefined,
          headers: (meta.headers as Record<string, string>) ?? {},
          contentType: meta.content_type ? String(meta.content_type) : undefined,
          payload: env.payload,
          caller: env.caller,
        }
      }
      default:
        return { kind: "unknown", raw: data }
    }
  }

  export function wsSend(input: {
    targetAgentId: string
    event: string
    payload: unknown
    requestId?: string
  }): string {
    const requestId = input.requestId ?? crypto.randomUUID()
    return JSON.stringify({
      type: "ws_send",
      request_id: requestId,
      meta: {
        target_agent_id: input.targetAgentId,
        event: input.event,
        content_type: "application/json",
      },
      payload: input.payload,
      caller: null,
    })
  }

  export function httpResponse(input: {
    requestId: string
    statusCode: number
    payload: unknown
    headers?: Record<string, string>
  }): string {
    return JSON.stringify({
      type: "http_response",
      request_id: input.requestId,
      meta: {
        status_code: input.statusCode,
        headers: { "content-type": "application/json", ...input.headers },
        content_type: "application/json",
      },
      payload: input.payload,
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

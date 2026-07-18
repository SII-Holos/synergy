// Native boundary size contracts and provenance constants.
// These are the trusted limits applied at the native tunnel boundary
// before any data reaches runtime persistence or prompt use.

/** Maximum raw WebSocket frame size in bytes before JSON.parse. Frames exceeding this are rejected pre-parse. */
export const NATIVE_FRAME_SIZE_LIMIT = 1_048_576 // 1 MB

/** Maximum length of a native semantic string field (content, instructions, goal, etc.). */
export const NATIVE_MAX_STRING_LENGTH = 65_536 // 64 KB

/** Maximum length of a native identifier field (task_id, project_id, run_id, etc.). */
export const NATIVE_MAX_ID_LENGTH = 256

/** Maximum depth of nested objects in native payloads before redaction. */
export const NATIVE_MAX_OBJECT_DEPTH = 16

/** Maximum number of file_refs entries in a native message. */
export const NATIVE_MAX_FILE_REFS = 200
/** Maximum serialized byte budget for a single semantic DTO. DTOs exceeding this are rejected. */
export const NATIVE_MAX_PAYLOAD_BYTES = 262_144 // 256 KB

/** Maximum number of keys in a single object level within bounded payloads. */
export const NATIVE_MAX_OBJECT_KEYS = 200

/** Maximum array length for bounded payload arrays. */
export const NATIVE_MAX_ARRAY_LENGTH = 200
// Generic Holos Agent Tunnel native types (Layer 1 — independent of Clarus).

export type NativeMessage = {
  type: string
  requestID: string | null
  meta: Record<string, unknown>
  payload: unknown
  caller: unknown // Opaque wire data; never use for identity or authorization.
  agentID: string // Trusted identity from the authenticated tunnel connection.
  sessionID: string | null
  generation: number
  epoch: number
}

export type HolosConnectionEvent =
  | { type: "connected"; agentID: string; sessionID: string; generation: number; epoch: number }
  | {
      type: "disconnected"
      agentID: string
      sessionID: string | null
      generation: number
      epoch: number
      code?: number
      reason?: string
    }

export type RequestID = string

export type NativeRequestFailure =
  | { disposition: "not_dispatched"; requestID: RequestID; code: string; message: string }
  | { disposition: "rejected"; requestID: RequestID; code: string; message: string }
  | {
      disposition: "ambiguous"
      requestID: RequestID
      reason: "timeout" | "aborted_after_dispatch" | "disconnected" | "invalid_response" | "unexpected_response"
      message: string
    }

export interface NativeTunnelPort {
  registerNativeObserver(handler: (msg: NativeMessage) => void | Promise<void>): () => void
  registerConnectionObserver(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void
  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: RequestID
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): { response: Promise<NativeMessage>; requestID: RequestID }
}

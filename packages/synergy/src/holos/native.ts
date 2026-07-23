export const NATIVE_FRAME_SIZE_LIMIT = 1_048_576
export const NATIVE_MAX_STRING_LENGTH = 65_536
export const NATIVE_MAX_ID_LENGTH = 256
export const NATIVE_MAX_OBJECT_DEPTH = 16
export const NATIVE_MAX_FILE_REFS = 200
export const NATIVE_MAX_PAYLOAD_BYTES = 262_144
export const NATIVE_MAX_OBJECT_KEYS = 200
export const NATIVE_MAX_ARRAY_LENGTH = 200

export type NativeMessage = {
  type: string
  requestID: string | null
  meta: Record<string, unknown>
  payload: unknown
  caller: Record<string, unknown> | null
  agentID: string
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

import z from "zod"

export namespace HolosProtocol {
  export const PeerProfile = z.object({
    name: z.string(),
    description: z.string().optional(),
  })
  export type PeerProfile = z.infer<typeof PeerProfile>

  export const PeerStatus = z.enum(["online", "offline"])
  export type PeerStatus = z.infer<typeof PeerStatus>

  export const BindExchangeRequest = z.object({
    code: z.string(),
    state: z.string(),
    profile: z.record(z.string(), z.unknown()),
  })
  export type BindExchangeRequest = z.infer<typeof BindExchangeRequest>

  export const BindExchangeResponse = z.object({
    code: z.number(),
    msg: z.string().optional(),
    message: z.string().optional(),
    data: z.object({
      agent_id: z.string(),
      agent_secret: z.string().optional(),
      secret: z.string().optional(),
    }),
  })
  export type BindExchangeResponse = z.infer<typeof BindExchangeResponse>

  export const WsTokenResponse = z.object({
    code: z.number(),
    message: z.string().optional(),
    data: z.object({
      ws_token: z.string(),
      expires_in: z.number(),
    }),
  })
  export type WsTokenResponse = z.infer<typeof WsTokenResponse>

  export const AgentInfo = z.object({
    agent_id: z.string().optional(),
    agent_key: z.string().optional(),
    owner_id: z.string(),
    owner_name: z.string(),
    is_active: z.boolean(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  export type AgentInfo = z.infer<typeof AgentInfo>

  export const AgentListResponse = z.object({
    code: z.number(),
    message: z.string().optional(),
    data: z.object({
      items: z.array(AgentInfo),
      total: z.number(),
    }),
  })
  export type AgentListResponse = z.infer<typeof AgentListResponse>

  export const AgentDetailResponse = z.object({
    code: z.number(),
    message: z.string().optional(),
    data: AgentInfo,
  })
  export type AgentDetailResponse = z.infer<typeof AgentDetailResponse>

  export const Caller = z.object({
    type: z.string(),
    agent_id: z.string(),
    owner_user_id: z.number(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  export type Caller = z.infer<typeof Caller>

  export const EnvelopeType = z.enum([
    "connected",
    "ping",
    "pong",
    "error",
    "ws_send",
    "ws_failed",
    "http_request",
    "http_response",
  ])
  export type EnvelopeType = z.infer<typeof EnvelopeType>

  export const Envelope = z.object({
    type: z.string(),
    request_id: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()),
    payload: z.unknown().nullable(),
    caller: Caller.nullable().optional(),
  })
  export type Envelope = z.infer<typeof Envelope>

  export const AppEvent = z.enum(["chat.message", "presence.ping", "presence.pong"])
  export type AppEvent = z.infer<typeof AppEvent>

  export const ChatMessagePayload = z.object({
    text: z.string(),
    messageId: z.string(),
    replyTo: z.string().optional(),
    source: z.enum(["agent", "human"]).optional(),
  })
  export type ChatMessagePayload = z.infer<typeof ChatMessagePayload>

  export const PresencePingPayload = z.object({})
  export type PresencePingPayload = z.infer<typeof PresencePingPayload>

  export const PresencePongPayload = z.object({
    profile: PeerProfile,
  })
  export type PresencePongPayload = z.infer<typeof PresencePongPayload>
}

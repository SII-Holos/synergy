import z from "zod"

export namespace HolosProtocol {
  export const PeerProfile = z.object({
    name: z.string(),
    bio: z.string().optional(),
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

  export const AppEvent = z.enum([
    "friend.request",
    "friend.accept",
    "friend.reject",
    "friend.remove",
    "chat.message",
    "profile.update",
    "presence.ping",
    "presence.pong",
  ])
  export type AppEvent = z.infer<typeof AppEvent>

  export const FriendRequestPayload = z.object({
    profile: PeerProfile,
  })
  export type FriendRequestPayload = z.infer<typeof FriendRequestPayload>

  export const FriendAcceptPayload = z.object({
    profile: PeerProfile,
  })
  export type FriendAcceptPayload = z.infer<typeof FriendAcceptPayload>

  export const FriendRejectPayload = z.object({})
  export type FriendRejectPayload = z.infer<typeof FriendRejectPayload>

  export const FriendRemovePayload = z.object({})
  export type FriendRemovePayload = z.infer<typeof FriendRemovePayload>

  export const ChatMessagePayload = z.object({
    text: z.string(),
    messageId: z.string(),
    replyTo: z.string().optional(),
    source: z.enum(["agent", "human"]).optional(),
  })
  export type ChatMessagePayload = z.infer<typeof ChatMessagePayload>

  export const ProfileUpdatePayload = z.object({
    profile: PeerProfile,
  })
  export type ProfileUpdatePayload = z.infer<typeof ProfileUpdatePayload>

  export const PresencePingPayload = z.object({})
  export type PresencePingPayload = z.infer<typeof PresencePingPayload>

  export const PresencePongPayload = z.object({
    profile: PeerProfile,
  })
  export type PresencePongPayload = z.infer<typeof PresencePongPayload>

  const DAY_MS = 24 * 60 * 60 * 1000

  export const QueueExpiry: Record<string, number> = {
    "friend.request": 30 * DAY_MS,
    "friend.accept": 30 * DAY_MS,
    "friend.reject": 30 * DAY_MS,
    "friend.remove": 30 * DAY_MS,
    "profile.update": 30 * DAY_MS,
    "chat.message": 7 * DAY_MS,
  }

  export const DEFAULT_QUEUE_EXPIRY = 7 * DAY_MS
}

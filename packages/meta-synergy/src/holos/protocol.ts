import z from "zod"

export namespace MetaSynergyHolosProtocol {
  export const Caller = z.object({
    type: z.string(),
    agent_id: z.string(),
    owner_user_id: z.number(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })

  export const Envelope = z.object({
    type: z.string(),
    request_id: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()),
    payload: z.unknown().nullable(),
    caller: Caller.nullable().optional(),
  })

  export const WsTokenResponse = z.object({
    code: z.number(),
    message: z.string().optional(),
    data: z.object({
      ws_token: z.string(),
      expires_in: z.number(),
    }),
  })

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
}

import z from "zod"
import { MetaProtocolEnvelope } from "./envelope"
import { MetaProtocolEnv } from "./env"

export namespace MetaProtocolSession {
  export const Action = z.enum(["open", "close", "heartbeat"])
  export type Action = z.infer<typeof Action>

  export const Status = z.enum(["opened", "closed", "alive", "refused", "busy"])
  export type Status = z.infer<typeof Status>

  export const ExecutePayload = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("open"),
      label: z.string().optional(),
    }),
    z.object({
      action: z.literal("close"),
      sessionID: MetaProtocolEnv.SessionID,
    }),
    z.object({
      action: z.literal("heartbeat"),
      sessionID: MetaProtocolEnv.SessionID,
    }),
  ])
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    action: Action,
    status: Status,
    sessionID: MetaProtocolEnv.SessionID.optional(),
    remoteAgentID: z.string().optional(),
    remoteOwnerUserID: z.number().optional(),
    label: z.string().optional(),
    hostSessionID: MetaProtocolEnv.HostSessionID.optional(),
    envID: MetaProtocolEnv.EnvID.optional(),
    backend: z.enum(["local", "remote"]).optional(),
  })
  export type ResultMetadata = z.infer<typeof ResultMetadata>

  export const Result = z.object({
    title: z.string(),
    metadata: ResultMetadata,
    output: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const ExecuteRequest = MetaProtocolEnvelope.RequestBase.extend({
    tool: z.literal("session"),
    action: Action,
    payload: ExecutePayload,
  })
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = MetaProtocolEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("session"),
    action: Action,
    result: Result,
  })
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

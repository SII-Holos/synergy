import z from "zod"
import { SynergyLinkEnvelope } from "./envelope"
import { SynergyLinkIdentity } from "./identity"

export namespace SynergyLinkSession {
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
      sessionID: SynergyLinkIdentity.SessionID,
    }),
    z.object({
      action: z.literal("heartbeat"),
      sessionID: SynergyLinkIdentity.SessionID,
    }),
  ])
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    action: Action,
    status: Status,
    sessionID: SynergyLinkIdentity.SessionID.optional(),
    remoteAgentID: z.string().optional(),
    remoteOwnerUserID: z.number().optional(),
    label: z.string().optional(),
    hostSessionID: SynergyLinkIdentity.HostSessionID.optional(),
    linkID: SynergyLinkIdentity.LinkID.optional(),
    backend: z.enum(["local", "remote"]).optional(),
    warnings: z.array(SynergyLinkIdentity.Warning).optional(),
  })
  export type ResultMetadata = z.infer<typeof ResultMetadata>

  export const Result = z.object({
    title: z.string(),
    metadata: ResultMetadata,
    output: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const ExecuteRequest = SynergyLinkEnvelope.RequestBase.extend({
    tool: z.literal("session"),
    action: Action,
    payload: ExecutePayload,
  }).strict()
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = SynergyLinkEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("session"),
    action: Action,
    result: Result,
  }).strict()
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

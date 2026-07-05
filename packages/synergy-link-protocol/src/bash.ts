import z from "zod"
import { SynergyLinkEnvelope } from "./envelope"
import { SynergyLinkIdentity } from "./identity"

export namespace SynergyLinkBash {
  export const ExecutePayload = z.object({
    command: z.string(),
    description: z.string(),
    workdir: z.string().optional(),
    background: z.boolean().optional(),
    yieldSeconds: z.number().optional(),
  })
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    output: z.string().optional(),
    description: z.string().optional(),
    exit: z.number().nullable().optional(),
    processId: SynergyLinkIdentity.ProcessID.optional(),
    background: z.boolean().optional(),
    durationMs: z.number().optional(),
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
    tool: z.literal("bash"),
    action: z.literal("execute"),
    sessionID: SynergyLinkIdentity.SessionID,
    payload: ExecutePayload,
  }).strict()
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = SynergyLinkEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("bash"),
    action: z.literal("execute"),
    result: Result,
  }).strict()
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

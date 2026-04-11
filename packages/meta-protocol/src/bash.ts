import z from "zod"
import { MetaProtocolEnvelope } from "./envelope"
import { MetaProtocolEnv } from "./env"

export namespace MetaProtocolBash {
  export const ExecutePayload = z.object({
    command: z.string(),
    description: z.string(),
    timeout: z.number().optional(),
    workdir: z.string().optional(),
    background: z.boolean().optional(),
    yieldMs: z.number().optional(),
  })
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    output: z.string().optional(),
    description: z.string().optional(),
    exit: z.number().nullable().optional(),
    processId: MetaProtocolEnv.ProcessID.optional(),
    background: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    durationMs: z.number().optional(),
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
    tool: z.literal("bash"),
    action: z.literal("execute"),
    sessionID: MetaProtocolEnv.SessionID,
    payload: ExecutePayload,
  })
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = MetaProtocolEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("bash"),
    action: z.literal("execute"),
    result: Result,
  })
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

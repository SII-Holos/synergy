import z from "zod"
import { MetaProtocolEnvelope } from "./envelope"
import { MetaProtocolEnv } from "./env"

export namespace MetaProtocolProcess {
  export const Action = z.enum(["list", "poll", "log", "write", "send-keys", "kill", "clear", "remove"])
  export type Action = z.infer<typeof Action>

  export const ProcessState = z.enum(["running", "completed", "failed", "killed"])
  export type ProcessState = z.infer<typeof ProcessState>

  export const ActionStatus = z.enum([
    "running",
    "completed",
    "failed",
    "killed",
    "not_found",
    "error",
    "cleared",
    "removed",
  ])
  export type ActionStatus = z.infer<typeof ActionStatus>

  export const ProcessInfo = z.object({
    processId: MetaProtocolEnv.ProcessID,
    status: ProcessState,
    command: z.string(),
    description: z.string().optional(),
    runtimeMs: z.number(),
  })
  export type ProcessInfo = z.infer<typeof ProcessInfo>

  export const ExecutePayload = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({
      action: z.literal("poll"),
      processId: MetaProtocolEnv.ProcessID,
      block: z.boolean().optional(),
      timeout: z.number().optional(),
    }),
    z.object({
      action: z.literal("log"),
      processId: MetaProtocolEnv.ProcessID,
      offset: z.number().optional(),
      limit: z.number().optional(),
    }),
    z.object({
      action: z.literal("write"),
      processId: MetaProtocolEnv.ProcessID,
      data: z.string(),
    }),
    z.object({
      action: z.literal("send-keys"),
      processId: MetaProtocolEnv.ProcessID,
      keys: z.array(z.string()),
    }),
    z.object({
      action: z.literal("kill"),
      processId: MetaProtocolEnv.ProcessID,
    }),
    z.object({
      action: z.literal("clear"),
      processId: MetaProtocolEnv.ProcessID,
    }),
    z.object({
      action: z.literal("remove"),
      processId: MetaProtocolEnv.ProcessID,
    }),
  ])
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    action: Action,
    processId: MetaProtocolEnv.ProcessID.optional(),
    status: ActionStatus.optional(),
    exitCode: z.number().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    nextOffset: z.number().optional(),
    hostSessionID: MetaProtocolEnv.HostSessionID.optional(),
    envID: MetaProtocolEnv.EnvID.optional(),
    backend: z.enum(["local", "remote"]).optional(),
    processes: z.array(ProcessInfo).optional(),
  })
  export type ResultMetadata = z.infer<typeof ResultMetadata>

  export const Result = z.object({
    title: z.string(),
    metadata: ResultMetadata,
    output: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const ExecuteRequest = MetaProtocolEnvelope.RequestBase.extend({
    tool: z.literal("process"),
    action: Action,
    sessionID: MetaProtocolEnv.SessionID,
    payload: ExecutePayload,
  })
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = MetaProtocolEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("process"),
    action: Action,
    result: Result,
  })
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

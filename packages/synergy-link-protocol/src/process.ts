import z from "zod"
import { SynergyLinkEnvelope } from "./envelope"
import { SynergyLinkIdentity } from "./identity"

export namespace SynergyLinkProcess {
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
    processId: SynergyLinkIdentity.ProcessID,
    status: ProcessState,
    command: z.string(),
    description: z.string().optional(),
    runtimeMs: z.number(),
  })
  export type ProcessInfo = z.infer<typeof ProcessInfo>

  export const ExecutePayload = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }).strict(),
    z
      .object({
        action: z.literal("poll"),
        processId: SynergyLinkIdentity.ProcessID,
        block: z.boolean().optional(),
        timeout: z.number().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("log"),
        processId: SynergyLinkIdentity.ProcessID,
        offset: z.number().optional(),
        limit: z.number().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("write"),
        processId: SynergyLinkIdentity.ProcessID,
        data: z.string(),
      })
      .strict(),
    z
      .object({
        action: z.literal("send-keys"),
        processId: SynergyLinkIdentity.ProcessID,
        keys: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        action: z.literal("kill"),
        processId: SynergyLinkIdentity.ProcessID,
      })
      .strict(),
    z
      .object({
        action: z.literal("clear"),
        processId: SynergyLinkIdentity.ProcessID,
      })
      .strict(),
    z
      .object({
        action: z.literal("remove"),
        processId: SynergyLinkIdentity.ProcessID,
      })
      .strict(),
  ])
  export type ExecutePayload = z.infer<typeof ExecutePayload>

  export const ResultMetadata = z.object({
    action: Action,
    processId: SynergyLinkIdentity.ProcessID.optional(),
    status: ActionStatus.optional(),
    exitCode: z.number().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    nextOffset: z.number().optional(),
    hostSessionID: SynergyLinkIdentity.HostSessionID.optional(),
    linkID: SynergyLinkIdentity.LinkID.optional(),
    backend: z.enum(["local", "remote"]).optional(),
    warnings: z.array(SynergyLinkIdentity.Warning).optional(),
    processes: z.array(ProcessInfo).optional(),
  })
  export type ResultMetadata = z.infer<typeof ResultMetadata>

  export const Result = z.object({
    title: z.string(),
    metadata: ResultMetadata,
    output: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const ExecuteRequest = SynergyLinkEnvelope.RequestBase.extend({
    tool: z.literal("process"),
    action: Action,
    sessionID: SynergyLinkIdentity.SessionID,
    payload: ExecutePayload,
  }).strict()
  export type ExecuteRequest = z.infer<typeof ExecuteRequest>

  export const ExecuteResult = SynergyLinkEnvelope.TypedResultBase.extend({
    ok: z.literal(true),
    tool: z.literal("process"),
    action: Action,
    result: Result,
  }).strict()
  export type ExecuteResult = z.infer<typeof ExecuteResult>
}

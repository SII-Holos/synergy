import z from "zod"
import { Identifier } from "../id/id"
import { SessionCortexContract } from "../session/cortex-contract"

export namespace CortexTypes {
  export const TaskStatus = z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"])
  export type TaskStatus = z.infer<typeof TaskStatus>
  export type TerminalTaskStatus = Exclude<TaskStatus, "queued" | "running">

  export function isTerminalStatus(status: unknown): status is TerminalTaskStatus {
    return status === "completed" || status === "error" || status === "cancelled" || status === "interrupted"
  }

  export const PluginTaskOwner = SessionCortexContract.PluginTaskOwner
  export type PluginTaskOwner = SessionCortexContract.PluginTaskOwner

  export const TaskUsage = SessionCortexContract.TaskUsage
  export type TaskUsage = SessionCortexContract.TaskUsage

  export const TaskToolProgress = z.object({
    id: z.string(),
    tool: z.string(),
    status: z.string(),
    title: z.string().optional(),
    updatedAt: z.number(),
  })
  export type TaskToolProgress = z.infer<typeof TaskToolProgress>

  export const TaskProgress = z.object({
    toolCalls: z.number(),
    lastTool: z.string().optional(),
    lastToolStatus: z.string().optional(),
    lastTitle: z.string().optional(),
    lastPartId: z.string().optional(),
    lastUpdate: z.number(),
    lastMessage: z.string().optional(),
    recentTools: z.array(TaskToolProgress).optional(),
  })
  export type TaskProgress = z.infer<typeof TaskProgress>

  export const ExecutionRole = z.enum(["primary", "delegated_subagent"])
  export type ExecutionRole = z.infer<typeof ExecutionRole>

  export const JsonSchemaObject = SessionCortexContract.JsonSchemaObject
  export type JsonSchemaObject = SessionCortexContract.JsonSchemaObject

  export const OutputConfig = SessionCortexContract.OutputConfig
  export type OutputConfig = SessionCortexContract.OutputConfig

  export const TaskOutput = SessionCortexContract.TaskOutput
  export type TaskOutput = SessionCortexContract.TaskOutput

  export const Task = z
    .object({
      id: Identifier.schema("cortex"),
      sessionID: Identifier.schema("session"),
      parentSessionID: Identifier.schema("session"),
      parentMessageID: Identifier.schema("message"),
      description: z.string(),
      prompt: z.string(),
      agent: z.string(),
      model: z
        .object({
          providerID: z.string(),
          modelID: z.string(),
        })
        .optional(),
      executionRole: ExecutionRole.optional(),
      category: z.string().optional(),

      dagNodeId: z.string().optional(),
      status: TaskStatus,
      startedAt: z.number(),
      completedAt: z.number().optional(),
      error: z.string().optional(),
      launchFailure: z.boolean().optional(),
      progress: TaskProgress.optional(),
      notifyParentOnComplete: z.boolean().optional(),
      visibility: z.enum(["visible", "hidden"]).optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      outputConfig: OutputConfig.optional(),
      output: TaskOutput.optional(),
      owner: PluginTaskOwner.optional(),
      timeoutMs: z.number().int().positive().optional(),
      usage: TaskUsage.optional(),
    })
    .meta({ ref: "CortexTask" })
  export type Task = z.infer<typeof Task>

  export const LaunchInput = z.object({
    description: z.string(),
    prompt: z.string(),
    agent: z.string(),
    executionRole: ExecutionRole.optional(),
    category: z.string().optional(),
    parentSessionID: Identifier.schema("session"),
    parentMessageID: Identifier.schema("message"),
    dagNodeId: z.string().optional(),
    sessionID: Identifier.schema("session").optional(),
    reuseInterrupted: z.boolean().optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    worktree: z
      .object({
        create: z.literal(true),
        name: z.string().optional(),
        baseRef: z.enum(["current", "fresh"]).optional().default("current"),
        baseRevision: z.string().min(1).optional(),
        failOnError: z.boolean().optional().default(false),
      })
      .optional(),
    notifyParentOnComplete: z.boolean().optional(),
    visibility: z.enum(["visible", "hidden"]).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    output: OutputConfig.optional(),
    owner: PluginTaskOwner.optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxCost: z.number().nonnegative().optional(),
  })
  export type LaunchInput = z.input<typeof LaunchInput>
  export type ParsedLaunchInput = z.output<typeof LaunchInput>
}

import z from "zod"
import { Identifier } from "../id/id"

export namespace CortexTypes {
  export const TaskStatus = z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"])
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const PluginTaskOwner = z.object({
    kind: z.literal("plugin").default("plugin"),
    pluginId: z.string(),
    pluginGeneration: z.string(),
    scopeId: z.string(),
    correlationId: z.string(),
  })
  export type PluginTaskOwner = z.infer<typeof PluginTaskOwner>

  export const TaskUsage = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    cost: z.number(),
  })
  export type TaskUsage = z.infer<typeof TaskUsage>

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

  export const JsonSchemaObject = z.record(z.string(), z.unknown())
  export type JsonSchemaObject = z.infer<typeof JsonSchemaObject>
  const MaxRepairTurns = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])

  export const OutputConfig = z.union([
    z.object({ mode: z.literal("summary").optional() }),
    z.object({ mode: z.literal("final_response") }),
    z.object({
      mode: z.literal("structured"),
      schema: JsonSchemaObject,
      maxRepairTurns: MaxRepairTurns.optional(),
    }),
  ])
  export type OutputConfig = z.infer<typeof OutputConfig>

  export const TaskOutput = z.union([
    z.object({
      mode: z.literal("summary"),
      value: z.string(),
    }),
    z.object({
      mode: z.literal("final_response"),
      value: z.string(),
    }),
    z.object({
      mode: z.literal("structured"),
      value: z.unknown(),
    }),
  ])
  export type TaskOutput = z.infer<typeof TaskOutput>

  export const WorkflowTaskOwner = z
    .object({
      kind: z.literal("workflow_run"),
      runID: z.string(),
      entityID: z.string(),
      seat: z.string().optional(),
      instance: z.number().int().optional(),
      correlationID: z.string(),
    })
    .meta({ ref: "CortexWorkflowTaskOwner" })
  export type WorkflowTaskOwner = z.infer<typeof WorkflowTaskOwner>

  export const TaskOwner = z
    .discriminatedUnion("kind", [PluginTaskOwner, WorkflowTaskOwner])
    .meta({ ref: "CortexTaskOwner" })
  export type TaskOwner = z.infer<typeof TaskOwner>

  export function taskOwnerFromStored(value: unknown): TaskOwner | undefined {
    if (value === undefined) return undefined
    return TaskOwner.parse(value)
  }

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
      owner: TaskOwner.optional(),

      dagNodeId: z.string().optional(),
      status: TaskStatus,
      startedAt: z.number(),
      completedAt: z.number().optional(),
      error: z.string().optional(),
      progress: TaskProgress.optional(),
      notifyParentOnComplete: z.boolean().optional(),
      visibility: z.enum(["visible", "hidden"]).optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      outputConfig: OutputConfig.optional(),
      output: TaskOutput.optional(),
      timeoutMs: z.number().int().positive().optional(),
      ownedWorktreeID: z.string().optional(),
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
    owner: TaskOwner.optional(),
    parentSessionID: Identifier.schema("session"),
    parentMessageID: Identifier.schema("message"),
    dagNodeId: z.string().optional(),
    sessionID: Identifier.schema("session").optional(),
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
      })
      .optional(),
    notifyParentOnComplete: z.boolean().optional(),
    visibility: z.enum(["visible", "hidden"]).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    output: OutputConfig.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  export type LaunchInput = z.infer<typeof LaunchInput>
}

import z from "zod"
import { Identifier } from "../id/id"

export namespace CortexTypes {
  export const TaskStatus = z.enum(["pending", "queued", "running", "completed", "error", "cancelled"])
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const TaskProgress = z.object({
    toolCalls: z.number(),
    lastTool: z.string().optional(),
    lastUpdate: z.number(),
    lastMessage: z.string().optional(),
  })
  export type TaskProgress = z.infer<typeof TaskProgress>

  export const ExecutionRole = z.enum(["primary", "delegated_subagent"])
  export type ExecutionRole = z.infer<typeof ExecutionRole>

  export const Task = z
    .object({
      id: Identifier.schema("cortex"),
      sessionID: Identifier.schema("session"),
      parentSessionID: Identifier.schema("session"),
      parentMessageID: Identifier.schema("message"),
      description: z.string(),
      prompt: z.string(),
      agent: z.string(),
      executionRole: ExecutionRole.optional(),
      category: z.string().optional(),

      dagNodeId: z.string().optional(),
      status: TaskStatus,
      startedAt: z.number(),
      completedAt: z.number().optional(),
      result: z.string().optional(),
      error: z.string().optional(),
      progress: TaskProgress.optional(),
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
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
  })
  export type LaunchInput = z.infer<typeof LaunchInput>
}

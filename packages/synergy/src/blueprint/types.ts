import z from "zod"
import { Identifier } from "../id/id"

export const LoopStatus = z.enum(["armed", "running", "waiting", "auditing", "completed", "failed", "cancelled"])

export const Info = z
  .object({
    id: Identifier.schema("blueprint_loop"),
    noteID: z.string(),
    noteVersion: z.number().optional(),
    title: z.string(),
    description: z.string().optional(),
    sessionID: z.string(),
    executionAgent: z.string().optional(),
    auditAgent: z.string(),
    auditSessionID: z.string().optional(),
    auditTaskID: z.string().optional(),
    stopRequest: z
      .object({
        summary: z.string(),
        completed: z.array(z.string()).optional(),
        evidence: z.array(z.string()).optional(),
        remaining: z.array(z.string()).optional(),
        requestedAt: z.number(),
        requesterSessionID: z.string(),
        requesterMessageID: z.string(),
      })
      .optional(),
    scopeID: z.string(),
    status: LoopStatus,
    runMode: z.enum(["current", "new", "worktree"]).optional(),
    parentSessionID: z.string().optional(),
    firstPrompt: z.string().optional(),
    userPrompt: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    loopIndex: z.number().optional(),
    source: z
      .enum(["user", "lattice", "plugin"])
      .meta({ description: "Owner that created and drives this loop lifecycle" }),
    sourceDigest: z.string().optional(),
    budget: z
      .object({
        maxRuntimeMs: z.number(),
        maxIterations: z.number(),
      })
      .optional(),
    pluginOwner: z
      .object({
        pluginId: z.string(),
        pluginGeneration: z.string(),
        scopeId: z.string(),
        correlationId: z.string().optional(),
      })
      .optional(),
    audit: z
      .object({
        lastReason: z.string().optional(),
        lastAuditedAt: z.number().optional(),
        attempts: z.number(),
      })
      .optional(),
    executionTools: z.record(z.string(), z.boolean()).optional(),
    auditTools: z.record(z.string(), z.boolean()).optional(),
    time: z.object({
      created: z.number(),
      started: z.number().optional(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
    model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
    terminalHookDeliveredAt: z.number().optional(),
    terminalHookError: z.string().optional(),
  })
  .meta({ ref: "BlueprintLoopInfo" })

export type Info = z.infer<typeof Info>

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
    scopeID: z.string(),
    status: LoopStatus,
    runMode: z.enum(["current", "new", "worktree"]).optional(),
    parentSessionID: z.string().optional(),
    firstPrompt: z.string().optional(),
    userPrompt: z.string().optional(),
    error: z.string().optional(),
    loopIndex: z.number().optional(),
    source: z.enum(["user", "lattice"]).meta({ description: "Owner that created and drives this loop lifecycle" }),
    audit: z
      .object({
        lastReason: z.string().optional(),
        lastAuditedAt: z.number().optional(),
        attempts: z.number(),
      })
      .optional(),
    time: z.object({
      created: z.number(),
      started: z.number().optional(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
    model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  })
  .meta({ ref: "BlueprintLoopInfo" })

export type Info = z.infer<typeof Info>

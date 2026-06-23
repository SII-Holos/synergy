import z from "zod"
import { Identifier } from "../id/id"

export const LoopStatus = z.enum(["running", "auditing", "completed", "failed", "cancelled"])

export const Info = z
  .object({
    id: Identifier.schema("blueprint_loop"),
    noteID: z.string(),
    noteVersion: z.number().optional(),
    title: z.string(),
    description: z.string().optional(),
    sessionID: z.string(),
    supervisorSessionID: z.string().optional(),
    scopeID: z.string(),
    status: LoopStatus,
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
  })
  .meta({ ref: "BlueprintLoopInfo" })

export type Info = z.infer<typeof Info>

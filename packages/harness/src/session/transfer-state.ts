import { z } from "zod"

export const SessionTransferState = z
  .object({
    migrationID: z.string().uuid(),
    sessionID: z.string(),
    sourceID: z.string().uuid(),
    targetID: z.string().uuid(),
    phase: z.enum(["preparing", "prepared", "committed", "completed", "cancelled"]),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: z.string().optional(),
  })
  .meta({ ref: "SessionTransferState" })

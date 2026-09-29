import { z } from "zod"

const Reason = z.string().min(1).max(200)
const Availability = z.object({ available: z.boolean(), reason: Reason.optional() }).strict()
const Dimension = z.number().int().positive().max(32768)

export const ComputerObservationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    target: z
      .object({
        pid: z.number().int().positive(),
        windowId: z.number().int().positive(),
        app: z.string().max(500),
        title: z.string().max(2000),
      })
      .strict(),
    capturedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    ax: z
      .object({
        status: z.enum(["available", "partial", "unavailable"]),
        truncated: z.boolean(),
        reason: Reason.optional(),
        query: z.string().max(200).optional(),
      })
      .strict(),
    image: z
      .object({
        status: z.enum(["valid", "unavailable", "unverified", "invalid"]),
        reason: Reason.optional(),
        width: Dimension.optional(),
        height: Dimension.optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        source: z.string().max(100).optional(),
      })
      .strict(),
    actions: z
      .object({ click: Availability, point: Availability, type: Availability, key: Availability, scroll: Availability })
      .strict(),
  })
  .strict()
export type ComputerObservation = z.infer<typeof ComputerObservationSchema>

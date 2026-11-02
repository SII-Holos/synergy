import { z } from "zod"

export const ResourceSnapshot = z
  .object({
    sampledAt: z.number(),
    quality: z.enum(["complete", "partial", "unavailable"]),
    pressure: z.enum(["normal", "warning", "critical"]),
    domains: z.array(
      z.object({
        kind: z.enum(["physical", "cgroup", "commit", "job", "process"]),
        capacityBytes: z.number().nonnegative(),
        availableBytes: z.number().nonnegative(),
      }),
    ),
    processRssBytes: z.number().nonnegative(),
  })
  .meta({ ref: "ResourceSnapshot" })
export type ResourceSnapshot = z.infer<typeof ResourceSnapshot>

export const ResourceStatus = z
  .object({
    revision: z.number().int().nonnegative(),
    snapshot: ResourceSnapshot.nullable(),
    state: z.enum(["normal", "constrained", "blocked", "recovering"]),
    reason: z.enum([
      "available",
      "memory_pressure",
      "critical_pressure",
      "unavailable_sample",
      "stale_sample",
      "headroom",
      "execution_capacity",
      "recovering",
      "closed",
    ]),
    reserveBytes: z.number().nonnegative(),
    reservedBytes: z.number().nonnegative(),
    headroomBytes: z.number().nonnegative(),
    active: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    nextReviewAt: z.number(),
  })
  .meta({ ref: "ResourceStatus" })
export type ResourceStatus = z.infer<typeof ResourceStatus>

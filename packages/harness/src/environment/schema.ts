import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { JsonValue } from "../util/json-value"

export namespace EnvironmentSchema {
  export const Target = z
    .object({
      environmentID: z.string().min(1),
      allocationID: z.string().min(1),
      generation: z.number().int().positive(),
    })
    .meta({ ref: "EnvironmentTarget" })
  export type Target = z.infer<typeof Target>
  export function sameTarget(a: Target, b: Target) {
    return a.environmentID === b.environmentID && a.generation === b.generation && a.allocationID === b.allocationID
  }
  export const Allocation = z.object({ id: z.string().min(1), capabilities: z.array(z.string()) })
  export type Allocation = z.infer<typeof Allocation>
  export const Info = z
    .object({
      id: z.string().min(1),
      scopeID: z.string().min(1),
      provider: z.string().min(1),
      spec: z.record(z.string(), JsonValue),
      ownership: z.enum(["borrowed", "managed"]),
      state: z.enum(["idle", "allocating", "ready", "releasing", "unavailable"]),
      generation: z.number().int().nonnegative(),
      allocation: z
        .object({
          requestID: z.string(),
          id: z.string().optional(),
          capabilities: z.array(z.string()).default([]),
        })
        .optional(),
      idleTimeoutMs: z.number().int().nonnegative(),
      createdAt: z.number(),
      updatedAt: z.number(),
      lastUsedAt: z.number(),
    })
    .meta({ ref: "EnvironmentInfo" })
  export type Info = z.infer<typeof Info>
  export const Use = z.object({ id: z.string(), target: Target, createdAt: z.number() })
  export type Use = z.infer<typeof Use>
  export const Unavailable = NamedError.create(
    "EnvironmentUnavailable",
    z.object({ message: z.string(), environmentID: z.string() }),
  )
  export const Stale = NamedError.create(
    "EnvironmentStale",
    z.object({ message: z.string(), environmentID: z.string() }),
  )
  export const Busy = NamedError.create("EnvironmentBusy", z.object({ message: z.string(), environmentID: z.string() }))
}

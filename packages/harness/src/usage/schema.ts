import { z } from "zod"
import { RolloutSchema } from "../session/rollout/schema"
import { RolloutUsage } from "../session/rollout/usage"
import { RolloutTiming } from "../session/rollout/timing"
import { ProviderPricing } from "../provider/pricing"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RolloutAccounting } from "../session/rollout/accounting"

export namespace UsageSchema {
  export const InvalidQuery = NamedError.create("UsageQueryInvalid", z.object({ message: z.string() }))
  export const base = {
    version: z.literal(1),
    id: z.string(),
    entityID: z.string(),
    owner: RolloutSchema.Owner,
    runID: z.string(),
    revision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().nonnegative(),
    started: z.number(),
    ended: z.number().optional(),
    status: RolloutSchema.Status,
    source: z.enum(["local", "imported", "legacy"]),
  }
  export const attribution = {
    purpose: z.string(),
    retryIndex: z.number().int().nonnegative().optional(),
    agent: z.string().optional(),
    model: RolloutSchema.Model,
    execution: z.enum(["provider", "local", "external"]),
    callKind: z.enum(["chat", "embedding", "rerank", "transcription", "speech"]),
  }
  export const Run = z
    .object({
      ...base,
      kind: z.literal("run"),
      parent: RolloutSchema.RunRecord.shape.parent,
      parentOwner: RolloutSchema.Owner.optional(),
    })
    .strict()
  export const Link = Run.pick({ owner: true, runID: true, parent: true, parentOwner: true })
  export type Link = z.infer<typeof Link>
  export const Gap = z.object({ ...base, kind: z.literal("gap"), sequence: z.number().int().positive() }).strict()
  export const Call = z
    .object({
      ...base,
      ...attribution,
      kind: z.literal("call"),
      parentCallID: z.string().optional(),
      usage: RolloutUsage.Info.optional(),
      estimate: ProviderPricing.Estimate.optional(),
      hasAttempts: z.boolean(),
    })
    .strict()
  export const Attempt = z
    .object({
      ...base,
      ...attribution,
      kind: z.literal("attempt"),
      callID: z.string(),
      index: z.number().int().nonnegative(),
      usage: RolloutUsage.Info.optional(),
      estimate: ProviderPricing.Estimate.optional(),
      timing: RolloutTiming.Info.optional(),
      usageFinal: z.boolean(),
      httpStatus: z.number().int().optional(),
      responseModel: z.string().max(256).optional(),
    })
    .strict()
  export const Tool = z
    .object({ ...base, kind: z.literal("tool"), tool: z.string(), durationMs: z.number().nonnegative().nullable() })
    .strict()
  export const Legacy = z
    .object({
      ...base,
      kind: z.literal("legacy"),
      ...attribution,
      usage: RolloutUsage.Info,
      legacyCost: z.number().finite(),
      accounting: RolloutAccounting.Summary.optional(),
    })
    .strict()
  export const Record = z
    .discriminatedUnion("kind", [Run, Call, Attempt, Tool, Legacy, Gap])
    .meta({ ref: "UsageRecord" })
  export type Record = z.infer<typeof Record>
  export type Owner = RolloutSchema.Owner
  export const Filter = z
    .object({
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      runID: z.string().optional(),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      agent: z.string().optional(),
      purpose: z.string().optional(),
      from: z.number().int().nonnegative().safe().optional(),
      to: z.number().int().nonnegative().safe().optional(),
      includeDescendants: z.boolean().default(true),
      timezone: z
        .string()
        .refine((value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value })
            return true
          } catch {
            return false
          }
        }, "Invalid IANA timezone")
        .optional(),
      kind: z.enum(["run", "call", "attempt", "tool", "legacy", "gap"]).optional(),
    })
    .strict()
  export type Filter = z.input<typeof Filter>
  export const Rebuild = z
    .object({
      version: z.literal(1),
      status: z.enum(["pending", "running", "completed", "failed"]),
      phase: z.enum(["indexes", "sessions", "operations", "completed"]),
      after: z.array(z.string()).optional(),
      ownerAfter: z.array(z.string()).optional(),
      owners: z.number().int().nonnegative(),
      records: z.number().int().nonnegative(),
      updatedAt: z.number(),
      failures: z.number().int().nonnegative(),
    })
    .strict()
  export type Rebuild = z.infer<typeof Rebuild>
}

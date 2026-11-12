import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"

export namespace RuntimeMaintenanceSchema {
  const ID = z.string().min(1).max(128)
  const Count = z.number().int().nonnegative().safe()
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Operator = ActorStamp.Info.refine(
    (actor) => actor.kind !== "account",
    "Maintenance requires trusted Host authority",
  )
  export const Purpose = z.enum(["organization-backup", "organization-restore"])
  export const Info = z.strictObject({
    version: z.literal(1),
    maintenanceID: ID,
    requestID: ID,
    requestHash: Hash,
    purpose: Purpose,
    sourceRuntimeID: ID,
    cohortHash: Hash,
    phase: z.enum(["draining", "frozen", "releasing", "released", "recovery-held"]),
    revision: Count.positive(),
    tailRevision: Count,
    actor: Operator,
    createdAt: Count,
    updatedAt: Count,
  })
}

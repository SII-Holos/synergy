import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { ReviewSchema } from "./schema"

export namespace ReviewState {
  export const Comment = z
    .object({
      id: z.string().min(1).max(100),
      source: z.string().max(500),
      fileKey: z.string().max(2000),
      file: z.string().max(2000),
      version: z.string().max(200),
      side: z.enum(["additions", "deletions"]),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
      excerpt: z.string().max(12_000),
      text: z.string().min(1).max(12_000),
      resolved: z.boolean(),
    })
    .refine((item) => item.end >= item.start && item.end - item.start < 200, "Invalid comment range")
    .meta({ ref: "ReviewComment" })
  export const Value = z
    .object({
      version: z.literal(1),
      comments: z.array(Comment).max(200),
      viewed: z.record(z.string().max(2500), z.string().max(200)).refine((value) => Object.keys(value).length <= 5000),
    })
    .meta({ ref: "ReviewStateValue" })
  export const Result = z
    .object({ revision: z.number().int().nonnegative(), state: Value })
    .meta({ ref: "ReviewStateResult" })
  export const Input = z
    .object({ sessionID: Identifier.schema("session"), revision: z.number().int().nonnegative(), state: Value })
    .meta({ ref: "ReviewStateInput" })
  export const Updated = BusEvent.define(
    "review.state.updated",
    z.object({ sessionID: Identifier.schema("session"), revision: z.number().int().nonnegative() }),
  )
  async function key(sessionID: string) {
    const session = await Session.get(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new ReviewSchema.Invalid({ message: "Review belongs to another scope." })
    return StoragePath.sessionReview(session.scope.id, sessionID)
  }
  export async function get(sessionID: string): Promise<z.infer<typeof Result>> {
    const target = await key(sessionID)
    try {
      const record = await Storage.versioned<z.infer<typeof Value>>(target)
      return { revision: Number(record.revision), state: Value.parse(record.value) }
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
      return { revision: 0, state: { version: 1, comments: [], viewed: {} } }
    }
  }
  export async function update(raw: z.infer<typeof Input>) {
    const input = Input.parse(raw)
    const target = await key(input.sessionID)
    const result = await Storage.transaction(async (tx) => {
      const record = await tx.versioned<z.infer<typeof Value>>(target).catch((error) => {
        if (!(error instanceof Storage.NotFoundError)) throw error
        return undefined
      })
      if (Number(record?.revision ?? 0) !== input.revision)
        throw new ReviewSchema.Conflict({ message: "Review notes changed. Reload before saving." })
      await tx.write(target, input.state, { expectedRevision: BigInt(input.revision) })
      return { revision: input.revision + 1, state: input.state }
    })
    await Bus.publish(Updated, { sessionID: input.sessionID, revision: result.revision })
    return result
  }
}

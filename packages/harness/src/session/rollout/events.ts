import { z } from "zod"
import { RolloutSchema } from "./schema"

/** Transaction-local evidence notifications for explicitly registered storage sinks. */
export namespace RolloutEvents {
  export const RecordCommitted = {
    type: "rollout.record.committed" as const,
    properties: z.strictObject({
      owner: RolloutSchema.Owner,
      revision: z.number().int().positive().safe(),
      time: z.number(),
      key: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1),
      value: z.json(),
    }),
  }
}

import { z } from "zod"

export namespace ActorStamp {
  const ID = z.string().min(1).max(128)
  const fields = {
    subjectID: ID,
    displayName: z.string().min(1).max(200),
    clientKind: z.enum(["web", "desktop", "cli", "api", "runtime", "system"]),
    requestID: ID,
  }
  const account = z.strictObject({ ...fields, kind: z.literal("account"), orgID: ID })
  const local = z.strictObject({ ...fields, kind: z.literal("local") })
  const system = z.strictObject({ ...fields, kind: z.literal("system"), orgID: ID.optional() })
  export const Principal = z.discriminatedUnion("kind", [account, local, system])
  export const Info = z
    .discriminatedUnion("kind", [
      account,
      local,
      system.extend({ causedBy: z.array(Principal).min(1).max(16).optional() }),
    ])
    .meta({ ref: "ActorStamp" })
  export type Info = z.infer<typeof Info>
}

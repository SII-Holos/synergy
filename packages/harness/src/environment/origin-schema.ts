import { z } from "zod"

export namespace EnvironmentOriginSchema {
  const ID = z.string().min(1)
  export const Session = z.strictObject({
    kind: z.literal("session"),
    scopeID: ID,
    sessionID: ID,
    rootID: ID,
    runID: ID,
    messageID: ID,
    callID: ID,
    tool: ID,
  })
  export type Session = z.infer<typeof Session>
  export const Host = z.strictObject({ kind: z.literal("host"), owner: ID, invocationID: ID })
  export const Current = z.discriminatedUnion("kind", [Session, Host])
  export type Current = z.infer<typeof Current>
  export const Info = z.discriminatedUnion("kind", [
    ...Current.options,
    z.strictObject({ kind: z.literal("legacy-unknown") }),
  ])
  export type Info = z.infer<typeof Info>
}

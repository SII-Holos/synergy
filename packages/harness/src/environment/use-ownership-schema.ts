import { z } from "zod"
import { EnvironmentOriginSchema } from "./origin-schema"

export namespace EnvironmentUseOwnershipSchema {
  const ID = z.string().min(1)
  const Generation = z.number().int().positive().safe()
  const Execution = z.strictObject({ kind: z.literal("execution"), scopeID: ID, operationID: ID })
  const Attachment = z.strictObject({
    kind: z.literal("workspace-attachment"),
    scopeID: ID,
    workspaceID: ID,
    bindingGeneration: Generation,
  })
  const Mount = z.strictObject({
    kind: z.literal("workspace-mount"),
    scopeID: ID,
    workspaceID: ID,
    bindingGeneration: Generation,
    mountID: ID,
    mountGeneration: Generation,
  })
  const Operation = z.strictObject({
    kind: z.literal("workspace-operation"),
    scopeID: ID,
    workspaceID: ID,
    operationID: ID,
  })
  export const Info = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("admission"), origin: EnvironmentOriginSchema.Current }),
    z.strictObject({
      kind: z.literal("execution-preparation"),
      scopeID: ID,
      operationID: ID,
      origin: EnvironmentOriginSchema.Current,
    }),
    Execution,
    Attachment,
    Mount,
    Operation,
    z.strictObject({ kind: z.literal("legacy-unknown") }),
  ])
  export type Info = z.infer<typeof Info>
  export type Current = Exclude<Info, { kind: "legacy-unknown" }>
  export type Resource = Exclude<Current, { kind: "admission" }>
}

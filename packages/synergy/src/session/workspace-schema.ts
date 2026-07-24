import z from "zod"

export const Workspace = z
  .object({
    type: z.string(),
    path: z.string(),
    scopeID: z.string(),
  })
  .passthrough()
  .meta({ ref: "SessionWorkspace" })
export type Workspace = z.infer<typeof Workspace>

import { z } from "zod"

export const Workspace = z
  .object({
    id: z.string().optional(),
    generation: z.number().int().positive().optional(),
    type: z.string().min(1),
    path: z.string().min(1),
    scopeID: z.string().min(1),
  })
  .passthrough()
  .meta({ ref: "SessionWorkspace" })
export type Workspace = z.infer<typeof Workspace>

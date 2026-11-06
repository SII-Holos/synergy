import z from "zod"

export const Local = z.object({
  directory: z.string().min(1),
  worktree: z.string().min(1),
  vcs: z.literal("git").optional(),
  sandboxes: z.array(z.string()),
})
export type Local = z.infer<typeof Local>

export const Home = z.object({
  type: z.literal("home"),
  id: z.literal("home"),
  local: z.null(),
})
export type Home = z.infer<typeof Home>

export const Project = z.object({
  type: z.literal("project"),
  id: z.string(),
  local: Local.nullable(),
  name: z.string().optional(),
  icon: z.object({ url: z.string().optional(), color: z.string().optional() }).optional(),
  pinned: z.number().optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    initialized: z.number().optional(),
    archived: z.number().optional(),
  }),
})
export type Project = z.infer<typeof Project>

export const Runtime = z.discriminatedUnion("type", [Home, Project])
export type Runtime = z.infer<typeof Runtime>
export type Scope = Runtime
export const Info = Project.meta({ ref: "Scope" })
export type Info = z.infer<typeof Info>

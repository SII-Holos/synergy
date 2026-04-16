import z from "zod"

export interface Global {
  type: "global"
  id: "global"
  directory: string
  worktree: string
}

export interface Project {
  type: "project"
  id: string
  directory: string
  worktree: string
  vcs?: "git"
  name?: string
  icon?: { url?: string; color?: string }
  sandboxes: string[]
  time: { created: number; updated: number; initialized?: number; archived?: number }
}

export type Scope = Global | Project

export const Info = z
  .object({
    id: z.string(),
    worktree: z.string(),
    vcs: z.literal("git").optional(),
    name: z.string().optional(),
    icon: z
      .object({
        url: z.string().optional(),
        color: z.string().optional(),
      })
      .optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      initialized: z.number().optional(),
      archived: z.number().optional(),
    }),
    sandboxes: z.array(z.string()),
  })
  .meta({ ref: "Scope" })
export type Info = z.infer<typeof Info>

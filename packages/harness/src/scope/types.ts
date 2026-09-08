import z from "zod"

export interface Home {
  type: "home"
  id: "home"
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
  pinned?: number
  time: { created: number; updated: number; initialized?: number; archived?: number }
}

export type Scope = Home | Project
const RuntimeBase = z.object({
  id: z.string(),
  directory: z.string(),
  worktree: z.string(),
})

export const Runtime = z.discriminatedUnion("type", [
  RuntimeBase.extend({
    type: z.literal("home"),
    id: z.literal("home"),
  }).strict(),
  RuntimeBase.extend({
    type: z.literal("project"),
    vcs: z.literal("git").optional(),
    name: z.string().optional(),
    icon: z.object({ url: z.string().optional(), color: z.string().optional() }).optional(),
    sandboxes: z.array(z.string()),
    pinned: z.number().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      initialized: z.number().optional(),
      archived: z.number().optional(),
    }),
  }).strict(),
])
export type Runtime = z.infer<typeof Runtime>

export const Info = z
  .object({
    id: z.string(),
    type: z.enum(["home", "project"]),
    directory: z.string(),
    worktree: z.string(),
    vcs: z.literal("git").optional(),
    name: z.string().optional(),
    icon: z
      .object({
        url: z.string().optional(),
        color: z.string().optional(),
      })
      .optional(),
    pinned: z.number().optional(),
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

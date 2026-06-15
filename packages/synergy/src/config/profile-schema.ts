import z from "zod"

export const ProfileMeta = z
  .object({
    name: z.string().min(1).max(64),
    inherits: z.string().optional(), // parent profile name
    description: z.string().optional(),
  })
  .strict()

export type ProfileMeta = z.infer<typeof ProfileMeta>

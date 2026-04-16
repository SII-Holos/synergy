import z from "zod"

export namespace NoteTypes {
  export const Info = z
    .object({
      id: z.string(),
      title: z.string(),
      content: z.any(),
      contentText: z.string(),
      pinned: z.boolean(),
      global: z.boolean(),
      originScope: z.string().optional(),
      tags: z.array(z.string()),
      version: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "NoteInfo" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      title: z.string(),
      content: z.any().optional(),
      contentText: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .meta({ ref: "NoteCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const PatchInput = z
    .object({
      title: z.string().optional(),
      content: z.any().optional(),
      contentText: z.string().optional(),
      pinned: z.boolean().optional(),
      global: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      expectedVersion: z.number().optional(),
    })
    .meta({ ref: "NotePatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>

  export const ScopeGroup = z
    .object({
      scopeID: z.string(),
      scopeType: z.enum(["global", "project"]),
      notes: z.array(Info),
    })
    .meta({ ref: "NoteScopeGroup" })
  export type ScopeGroup = z.infer<typeof ScopeGroup>
}

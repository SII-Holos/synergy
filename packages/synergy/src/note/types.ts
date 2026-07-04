import z from "zod"

export namespace NoteTypes {
  export const Info = z
    .object({
      id: z.string(),
      title: z.string(),
      content: z.any(),
      pinned: z.boolean(),
      global: z.boolean(),
      originScope: z.string().optional(),
      tags: z.array(z.string()),
      kind: z.enum(["note", "blueprint"]).optional(),
      blueprint: z
        .object({
          description: z.string().optional(),
          defaultAgent: z.string().optional(),
          auditAgent: z.string().optional(),
          activeLoopID: z.string().optional(),
          runCount: z.number().optional(),
          lastRunAt: z.number().optional(),
        })
        .optional(),
      archived: z.boolean(),
      version: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "NoteInfo" })

  export const CreateInput = z
    .object({
      title: z.string(),
      content: z.any().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.enum(["note", "blueprint"]).optional(),
      blueprint: z
        .object({
          description: z.string().optional(),
          defaultAgent: z.string().optional(),
          auditAgent: z.string().optional(),
          activeLoopID: z.string().optional(),
          runCount: z.number().optional(),
          lastRunAt: z.number().optional(),
        })
        .optional(),
    })
    .meta({ ref: "NoteCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const PatchInput = z
    .object({
      title: z.string().optional(),
      content: z.any().optional(),
      pinned: z.boolean().optional(),
      global: z.boolean().optional(),
      archived: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.enum(["note", "blueprint"]).optional(),
      blueprint: z
        .object({
          description: z.string().optional(),
          defaultAgent: z.string().optional(),
          auditAgent: z.string().optional(),
          activeLoopID: z.string().nullable().optional(),
          runCount: z.number().optional(),
          lastRunAt: z.number().optional(),
        })
        .nullable()
        .optional(),
      expectedVersion: z.number().optional(),
    })
    .meta({ ref: "NotePatchInput" })

  export const ScopeGroup = z
    .object({
      scopeID: z.string(),
      scopeType: z.enum(["home", "project"]),
      notes: z.array(Info),
    })
    .meta({ ref: "NoteScopeGroup" })
  export type ScopeGroup = z.infer<typeof ScopeGroup>

  export const MetaInfo = z
    .object({
      id: z.string(),
      title: z.string(),
      pinned: z.boolean(),
      global: z.boolean(),
      originScope: z.string().optional(),
      archived: z.boolean().optional(),
      tags: z.array(z.string()),
      kind: z.enum(["note", "blueprint"]).optional(),
      version: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
      searchText: z.string(),
      previewHtml: z.string().optional(),
      blueprint: z
        .object({
          description: z.string().optional(),
          defaultAgent: z.string().optional(),
          auditAgent: z.string().optional(),
          activeLoopID: z.string().optional(),
          runCount: z.number().optional(),
          lastRunAt: z.number().optional(),
        })
        .optional(),
    })
    .meta({ ref: "NoteMetaInfo" })

  export const MetaScopeGroup = z
    .object({
      scopeID: z.string(),
      scopeType: z.enum(["home", "project"]),
      notes: z.array(MetaInfo),
    })
    .meta({ ref: "NoteMetaScopeGroup" })
  export type MetaScopeGroup = z.infer<typeof MetaScopeGroup>
}

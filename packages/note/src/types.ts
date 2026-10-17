import z from "zod"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { NoteDocumentKinds } from "./document-kinds"

type ExtensionShape<T> = { [K in keyof T]: Extract<T[K], z.ZodType> }

export interface NoteInfoExtensions {}
export interface NoteCreateExtensions {}
export interface NotePatchExtensions {}

export namespace NoteTypes {
  export const ChangedField = ConfigExtensions.dynamicSchema(() =>
    z.enum(["title", "content", "tags", "pinned", "global", "kind", "archived", ...NoteDocumentKinds.fields()]),
  )
  export type ChangedField = z.infer<typeof ChangedField>

  const InfoBase = z
    .object({
      id: z.string(),
      title: z.string(),
      content: z.any(),
      pinned: z.boolean(),
      global: z.boolean(),
      originScope: z.string().optional(),
      tags: z.array(z.string()),
      kind: z.string().optional(),
      archived: z.boolean(),
      version: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "NoteInfo" })
  export const Info = NoteDocumentKinds.schema(InfoBase, "info") as z.ZodObject<
    typeof InfoBase.shape & ExtensionShape<NoteInfoExtensions>
  >

  const CreateInputBase = z
    .object({
      title: z.string(),
      content: z.any().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.string().optional(),
    })
    .meta({ ref: "NoteCreateInput" })
  export const CreateInput = NoteDocumentKinds.schema(CreateInputBase, "create") as z.ZodObject<
    typeof CreateInputBase.shape & ExtensionShape<NoteCreateExtensions>
  >
  export type CreateInput = z.infer<typeof CreateInput>

  const PatchInputBase = z
    .object({
      title: z.string().optional(),
      content: z.any().optional(),
      pinned: z.boolean().optional(),
      global: z.boolean().optional(),
      archived: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.string().optional(),
      expectedVersion: z.number().optional(),
    })
    .meta({ ref: "NotePatchInput" })
  export const PatchInput = NoteDocumentKinds.schema(PatchInputBase, "patch") as z.ZodObject<
    typeof PatchInputBase.shape & ExtensionShape<NotePatchExtensions>
  >

  export const ScopeGroup = z
    .object({
      scopeID: z.string(),
      scopeType: z.enum(["home", "project"]),
      notes: z.array(Info),
    })
    .meta({ ref: "NoteScopeGroup" })
  export type ScopeGroup = z.infer<typeof ScopeGroup>

  const MetaInfoBase = z
    .object({
      id: z.string(),
      title: z.string(),
      pinned: z.boolean(),
      global: z.boolean(),
      originScope: z.string().optional(),
      archived: z.boolean().optional(),
      tags: z.array(z.string()),
      kind: z.string().optional(),
      version: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
      searchText: z.string(),
      previewHtml: z.string().optional(),
    })
    .meta({ ref: "NoteMetaInfo" })
  export const MetaInfo = NoteDocumentKinds.schema(MetaInfoBase, "info") as z.ZodObject<
    typeof MetaInfoBase.shape & ExtensionShape<NoteInfoExtensions>
  >

  export const MetaScopeGroup = z
    .object({
      scopeID: z.string(),
      scopeType: z.enum(["home", "project"]),
      notes: z.array(MetaInfo),
    })
    .meta({ ref: "NoteMetaScopeGroup" })
  export type MetaScopeGroup = z.infer<typeof MetaScopeGroup>
}

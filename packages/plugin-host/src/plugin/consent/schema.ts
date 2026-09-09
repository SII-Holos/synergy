import z from "zod"
import { SYNERGY_CAPABILITY_CATEGORIES } from "@ericsanchezok/synergy-util/capability"

export const PermissionItemCategorySchema = z.enum(SYNERGY_CAPABILITY_CATEGORIES)

export const PermissionItemSchema = z.object({
  key: z.string(),
  category: PermissionItemCategorySchema,
  title: z.string(),
  description: z.string(),
  technical: z.string().optional(),
})

export type PermissionItem = z.infer<typeof PermissionItemSchema>

export const PluginPermissionDiffSchema = z.object({
  pluginId: z.string(),
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  access: z.array(PermissionItemSchema),
  added: z.array(PermissionItemSchema),
  broadened: z.array(PermissionItemSchema),
  removed: z.array(PermissionItemSchema),
  requiresConfirmation: z.boolean(),
  confirmationReason: z.enum(["non_official_source", "access_expanded", "publisher_changed"]).optional(),
  reason: z.string().optional(),
})

export type PluginPermissionDiff = z.infer<typeof PluginPermissionDiffSchema>

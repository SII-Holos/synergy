import z from "zod"
import { SYNERGY_CAPABILITY_CATEGORIES } from "@ericsanchezok/synergy-util/capability"

export const PermissionItemCategorySchema = z.enum(SYNERGY_CAPABILITY_CATEGORIES)

export const PermissionSeveritySchema = z.enum(["low", "medium", "high"])

export const PermissionItemSchema = z.object({
  key: z.string(),
  category: PermissionItemCategorySchema,
  severity: PermissionSeveritySchema,
  title: z.string(),
  description: z.string(),
  technical: z.string().optional(),
})

export type PermissionItem = z.infer<typeof PermissionItemSchema>

export const PermissionChangeSchema = z.object({
  key: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
})

export type PermissionChange = z.infer<typeof PermissionChangeSchema>

export const PluginPermissionDiffSchema = z.object({
  pluginId: z.string(),
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  riskBefore: PermissionSeveritySchema.optional(),
  riskAfter: PermissionSeveritySchema.optional(),
  added: z.array(PermissionItemSchema),
  removed: z.array(PermissionItemSchema),
  unchanged: z.array(PermissionItemSchema),
  changed: z.array(PermissionChangeSchema),
  requiresApproval: z.boolean(),
  reason: z.string().optional(),
})

export type PluginPermissionDiff = z.infer<typeof PluginPermissionDiffSchema>

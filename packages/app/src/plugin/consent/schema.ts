import type { PluginPermissionItem, PluginPermissionSeverity } from "@ericsanchezok/synergy-plugin/permissions"
import type { TrustTier as PluginTrustTier } from "@ericsanchezok/synergy-plugin/policy"

export type PermissionSeverity = PluginPermissionSeverity
export type PermissionItem = PluginPermissionItem

export interface PermissionChange {
  key: string
  before?: string
  after?: string
}

export interface PluginPermissionDiff {
  pluginId: string
  fromVersion?: string
  toVersion?: string
  riskBefore?: PermissionSeverity
  riskAfter?: PermissionSeverity
  added: PermissionItem[]
  removed: PermissionItem[]
  unchanged: PermissionItem[]
  changed: PermissionChange[]
  requiresApproval: boolean
  reason?: string
}

export type TrustTier = PluginTrustTier

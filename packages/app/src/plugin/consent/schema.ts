/**
 * Consent component types — mirrors packages/synergy/src/plugin/consent/schema.ts
 * but self-contained for the app layer.
 */

export type PermissionItemCategory = "tools" | "files" | "network" | "data" | "ui" | "runtime" | "hooks"

export type PermissionSeverity = "low" | "medium" | "high"

export interface PermissionItem {
  key: string
  category: PermissionItemCategory
  severity: PermissionSeverity
  title: string
  description: string
  technical?: string
}

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

export type TrustTier = "declarative" | "trusted-import" | "sandbox"

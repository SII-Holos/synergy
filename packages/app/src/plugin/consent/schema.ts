export type PermissionSeverity = "low" | "medium" | "high"
export interface PermissionItem {
  key: string
  category: string
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

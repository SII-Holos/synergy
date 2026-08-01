export interface PermissionItem {
  key: string
  category: string
  title: string
  description: string
  technical?: string
}

export interface PluginPermissionDiff {
  pluginId: string
  fromVersion?: string
  toVersion?: string
  access: PermissionItem[]
  added: PermissionItem[]
  broadened: PermissionItem[]
  removed: PermissionItem[]
  requiresConfirmation: boolean
  confirmationReason?: "non_official_source" | "access_expanded" | "publisher_changed"
  reason?: string
}

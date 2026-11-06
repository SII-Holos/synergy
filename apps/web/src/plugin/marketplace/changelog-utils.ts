import type { RegistryPluginVersion, RegistryPermissionItem } from "@ericsanchezok/synergy-sdk/client"

export interface VersionChangelogEntry {
  version: string
  publishedAt: number
  changelog?: string
  added: RegistryPermissionItem[]
  removed: RegistryPermissionItem[]
  unchanged: RegistryPermissionItem[]
}

export function computeVersionDiffs(versions: RegistryPluginVersion[]): VersionChangelogEntry[] {
  const sorted = [...versions].sort((left, right) => left.publishedAt - right.publishedAt)
  const previous = new Map<string, RegistryPermissionItem>()
  return sorted.map((version) => {
    const permissions = version.permissionsSummary ?? []
    const current = new Set(permissions.map((permission) => permission.key))
    const added = permissions.filter((permission) => !previous.has(permission.key))
    const unchanged = permissions.filter((permission) => previous.has(permission.key))
    const removed = [...previous.values()].filter((permission) => !current.has(permission.key))
    previous.clear()
    for (const permission of permissions) previous.set(permission.key, permission)
    return {
      version: version.version,
      publishedAt: version.publishedAt,
      changelog: version.changelog,
      added,
      removed,
      unchanged,
    }
  })
}

import type { RegistryPluginVersion, RegistryPermissionItem } from "@ericsanchezok/synergy-sdk/client"

export interface VersionChangelogEntry {
  version: string
  publishedAt: number
  risk: "low" | "medium" | "high"
  changelog?: string
  added: RegistryPermissionItem[]
  removed: RegistryPermissionItem[]
  unchanged: RegistryPermissionItem[]
  changed: Array<{ key: string; before: string; after: string }>
}

/**
 * Compute per-version permission diffs from a list of versions.
 * Versions are sorted by publishedAt ascending, then each version is compared
 * against the cumulative set of permissions from all prior versions.
 * Returns one entry per version with added/removed/unchanged/changed breakdowns.
 */
export function computeVersionDiffs(versions: RegistryPluginVersion[]): VersionChangelogEntry[] {
  if (versions.length === 0) return []

  const sorted = [...versions].sort((a, b) => a.publishedAt - b.publishedAt)

  const result: VersionChangelogEntry[] = []

  // Track the cumulative permission set: key -> RegistryPermissionItem
  const cumulative = new Map<string, RegistryPermissionItem>()

  for (const v of sorted) {
    const perms = v.permissionsSummary ?? []
    const currentKeys = new Set(perms.map((p) => p.key))

    const added: RegistryPermissionItem[] = []
    const removed: RegistryPermissionItem[] = []
    const unchanged: RegistryPermissionItem[] = []
    const changed: Array<{ key: string; before: string; after: string }> = []

    // Find added and changed
    for (const p of perms) {
      const prev = cumulative.get(p.key)
      if (!prev) {
        added.push(p)
      } else if (prev.risk !== p.risk) {
        changed.push({ key: p.key, before: prev.risk, after: p.risk })
        // Replace the cumulative entry
        cumulative.set(p.key, p)
      } else {
        unchanged.push(p)
      }
    }

    // Find removed
    for (const [key, prev] of cumulative) {
      if (!currentKeys.has(key)) {
        removed.push(prev)
        cumulative.delete(key)
      }
    }

    result.push({
      version: v.version,
      publishedAt: v.publishedAt,
      risk: v.risk,
      changelog: v.changelog,
      added,
      removed,
      unchanged,
      changed,
    })

    // Add all new permissions to cumulative set
    for (const p of perms) {
      if (!cumulative.has(p.key)) {
        cumulative.set(p.key, p)
      }
    }
  }

  return result
}

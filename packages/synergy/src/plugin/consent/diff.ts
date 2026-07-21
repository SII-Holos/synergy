import { riskForCapabilities } from "../capability"
import { generatePermissionItems } from "./summary"
import type { PermissionChange, PermissionItem, PluginPermissionDiff } from "./schema"

export interface DiffPermissionsState {
  oldVersion?: string
  newVersion: string
  oldCapabilities: string[]
  newCapabilities: string[]
}

/**
 * Diff permissions between two states.
 *
 * - `oldVersion === undefined` means a new plugin installation; all items go into "added".
 * - Compares resolved capabilities as sets: added, removed, unchanged.
 * - For unchanged capabilities, checks whether severity changed between versions.
 * - `requiresApproval` is true when there are additions, severity changes, or risk changes.
 */
export function diffPermissions(pluginId: string, state: DiffPermissionsState): PluginPermissionDiff {
  const { oldVersion, newVersion, oldCapabilities, newCapabilities } = state

  // New plugin install: everything is added
  if (oldVersion === undefined) {
    const items = generatePermissionItems(newCapabilities)
    return {
      pluginId,
      fromVersion: undefined,
      toVersion: newVersion,
      riskBefore: undefined,
      riskAfter: riskForCapabilities(newCapabilities),
      added: items,
      removed: [],
      unchanged: [],
      changed: [],
      requiresApproval: items.length > 0,
      reason: items.length > 0 ? "New plugin installation — all permissions require approval." : undefined,
    }
  }

  const oldSet = new Set(oldCapabilities)
  const newSet = new Set(newCapabilities)

  // Capability diff: added = in new but not old, removed = in old but not new, unchanged = both
  const addedCaps = [...newSet].filter((c) => !oldSet.has(c))
  const removedCaps = [...oldSet].filter((c) => !newSet.has(c))
  const unchangedCaps = [...newSet].filter((c) => oldSet.has(c))

  // Generate items from both capability sets
  const oldItems = generatePermissionItems(oldCapabilities)
  const newItems = generatePermissionItems(newCapabilities)

  const oldByKey = new Map(oldItems.map((i) => [i.key, i]))
  const newByKey = new Map(newItems.map((i) => [i.key, i]))

  const added = addedCaps.map((k) => newByKey.get(k)).filter((i): i is PermissionItem => i != null)
  const removed = removedCaps.map((k) => oldByKey.get(k)).filter((i): i is PermissionItem => i != null)
  const unchanged = unchangedCaps.map((k) => newByKey.get(k)).filter((i): i is PermissionItem => i != null)

  // Find severity changes in unchanged capabilities
  const changed: PermissionChange[] = []
  for (const key of unchangedCaps) {
    const oldItem = oldByKey.get(key)
    const newItem = newByKey.get(key)
    if (oldItem && newItem && oldItem.severity !== newItem.severity) {
      changed.push({
        key,
        before: oldItem.severity,
        after: newItem.severity,
      })
    }
  }

  const riskBefore = riskForCapabilities(oldCapabilities)
  const riskAfter = riskForCapabilities(newCapabilities)
  const requiresApproval = added.length > 0 || removed.length > 0 || changed.length > 0 || riskBefore !== riskAfter

  return {
    pluginId,
    fromVersion: oldVersion,
    toVersion: newVersion,
    riskBefore,
    riskAfter,
    added,
    removed,
    unchanged,
    changed,
    requiresApproval,
    reason: requiresApproval ? "Permission changes detected between versions." : undefined,
  }
}

import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeRisk } from "./risk"
import { generatePermissionItems } from "./summary"
import type { PermissionChange, PermissionItem, PluginPermissionDiff } from "./schema"

/**
 * Diff permissions between two versions of a plugin manifest.
 *
 * - `oldManifest === null` means a new plugin installation; all items go into "added".
 * - Compares resolved capabilities as sets: added, removed, unchanged.
 * - For unchanged capabilities, checks whether severity changed between versions.
 * - `requiresApproval` is true when there are additions, severity changes, or risk changes.
 */
export function diffPermissions(
  pluginId: string,
  oldManifest: PluginManifest | null,
  newManifest: PluginManifest,
  oldCapabilities: string[],
  newCapabilities: string[],
): PluginPermissionDiff {
  const fromVersion = oldManifest?.version
  const toVersion = newManifest.version

  // New plugin install: everything is added
  if (oldManifest === null) {
    const items = generatePermissionItems(newManifest, newCapabilities)
    return {
      pluginId,
      fromVersion: undefined,
      toVersion,
      riskBefore: undefined,
      riskAfter: computeRisk(newCapabilities, newManifest),
      added: items,
      removed: [],
      unchanged: [],
      changed: [],
      requiresApproval: items.length > 0,
      reason: "New plugin installation — all permissions require approval.",
    }
  }

  const oldSet = new Set(oldCapabilities)
  const newSet = new Set(newCapabilities)

  // Capability diff: added = in new but not old, removed = in old but not new, unchanged = both
  const addedCaps = [...newSet].filter((c) => !oldSet.has(c))
  const removedCaps = [...oldSet].filter((c) => !newSet.has(c))
  const unchangedCaps = [...newSet].filter((c) => oldSet.has(c))

  // Generate items from both manifests
  const oldItems = generatePermissionItems(oldManifest, oldCapabilities)
  const newItems = generatePermissionItems(newManifest, newCapabilities)

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

  // Diff non-capability items (UI, hooks, data) between old and new manifests.
  // These have keys starting with "ui.", "data.", or "hooks." and are not in
  // the capability sets.
  const nonCapKeys = new Set([
    ...oldItems.filter((i) => !oldSet.has(i.key)).map((i) => i.key),
    ...newItems.filter((i) => !newSet.has(i.key)).map((i) => i.key),
  ])
  for (const key of nonCapKeys) {
    const oldItem = oldByKey.get(key)
    const newItem = newByKey.get(key)
    if (oldItem && !newItem) {
      removed.push(oldItem)
    } else if (!oldItem && newItem) {
      added.push(newItem)
    } else if (oldItem && newItem && oldItem.severity !== newItem.severity) {
      changed.push({
        key,
        before: oldItem.severity,
        after: newItem.severity,
      })
    }
  }

  const riskBefore = computeRisk(oldCapabilities, oldManifest)
  const riskAfter = computeRisk(newCapabilities, newManifest)
  const requiresApproval = added.length > 0 || removed.length > 0 || changed.length > 0 || riskBefore !== riskAfter

  return {
    pluginId,
    fromVersion,
    toVersion,
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

import { permissionItems } from "@ericsanchezok/synergy-util/capability"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PermissionItem } from "./schema"

/**
 * Generate user-language permission items from a plugin manifest and its
 * resolved capability strings.
 */
export function generatePermissionItems(manifest: PluginManifest, capabilities: string[]): PermissionItem[] {
  return permissionItems(manifest, capabilities) as PermissionItem[]
}

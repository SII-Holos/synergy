import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { sha256Content, sortKeys } from "./crypto"

export function computePermissionsHash(manifest: PluginManifest, capabilities: string[]): string {
  const normalized = {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: manifest.contributes?.ui != null ? { ui: manifest.contributes.ui } : undefined,
    hooks: manifest.permissions?.hooks ?? undefined,
  }
  return sha256Content(JSON.stringify(sortKeys(normalized)))
}

export function computeManifestHash(manifest: PluginManifest): string {
  const { contributes, lifecycle, permissions, ...identity } = manifest as PluginManifest & {
    contributes?: unknown
    lifecycle?: unknown
    permissions?: unknown
  }
  return sha256Content(JSON.stringify(sortKeys(identity)))
}

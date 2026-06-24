import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { sha256Content, sortKeys } from "./crypto"

export function computePermissionsHash(manifest: PluginManifest, capabilities: string[]): string {
  const normalized = {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: manifest.contributes ?? {},
    lifecycle: manifest.lifecycle ?? {},
  }
  return sha256Content(JSON.stringify(sortKeys(normalized)))
}

export function computeManifestHash(manifest: PluginManifest): string {
  return sha256Content(JSON.stringify(sortKeys(manifest)))
}

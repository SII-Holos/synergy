import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import {
  manifestHashPayload,
  permissionsHashPayload,
  stablePluginJson,
} from "@ericsanchezok/synergy-plugin/permissions"
import { sha256Content } from "./crypto.js"

export function computePermissionsHash(manifest: PluginManifest, capabilities: string[]): string {
  return sha256Content(stablePluginJson(permissionsHashPayload(manifest, capabilities)))
}

export function computeManifestHash(manifest: PluginManifest): string {
  return sha256Content(stablePluginJson(manifestHashPayload(manifest)))
}

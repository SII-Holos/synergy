import path from "path"
import { pathToFileURL } from "url"
import type { PluginDescriptor, PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"

export function resolveEntryFromPluginDir(pluginDir: string, manifest: PluginManifestType): string {
  const main = manifest.main ?? "./src/index.ts"
  return path.resolve(pluginDir, main)
}

export function importUrlForEntry(entryPath: string, nonce?: number): string {
  const url = pathToFileURL(entryPath)
  if (nonce !== undefined) url.searchParams.set("t", String(nonce))
  return url.toString()
}

export function assertCanonicalPluginIdentity(input: { manifest: PluginManifestType; descriptor: PluginDescriptor }) {
  const manifestId = input.manifest.name
  const descriptorId = input.descriptor.id
  if (!descriptorId) throw new Error("PluginDescriptor.id is required")
  if (manifestId !== descriptorId) {
    throw new Error(
      `Plugin identity mismatch: plugin.json.name "${manifestId}" does not match descriptor id "${descriptorId}"`,
    )
  }
}

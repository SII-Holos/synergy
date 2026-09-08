import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { read } from "./lockfile"
import { findPackageRoot, readPluginManifest } from "./spec-resolver"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"

export async function installedPluginCliMetadata(): Promise<Array<{ id: string; manifest: PluginManifestType }>> {
  const lock = await read().catch((error) => {
    console.error(`Plugin CLI metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (!lock) return []
  const result: Array<{ id: string; manifest: PluginManifestType }> = []
  for (const [id, entry] of Object.entries(lock.plugins).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const manifest = await readPluginManifest(findPackageRoot(entry.resolved))
      if (manifest.id !== id || computeManifestHash(manifest) !== entry.manifestHash) continue
      if (manifest.contributions.some((entry) => entry.kind === "cli.command")) result.push({ id, manifest })
    } catch (error) {
      // A missing or damaged installation must not prevent help for the remaining commands.
      console.error(
        `Plugin CLI metadata unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}

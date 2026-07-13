import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { sha256Content } from "./crypto.js"

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]),
  )
}

export function computeManifestHash(manifest: PluginManifest) {
  return sha256Content(JSON.stringify(stable(manifest)))
}

export function computePermissionsHash(
  manifest: PluginManifest,
  capabilities = manifest.capabilities.map((item) => item.id),
) {
  return sha256Content(
    JSON.stringify(
      stable({
        capabilities: manifest.capabilities.filter((item) => capabilities.includes(item.id)),
        requirements: manifest.contributions.map((item) => ({
          kind: item.kind,
          id: item.id,
          requires: item.requires ?? [],
        })),
      }),
    ),
  )
}

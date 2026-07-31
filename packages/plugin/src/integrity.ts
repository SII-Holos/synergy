import { createHash } from "node:crypto"
import { hasTrustedUIComponent, type PluginManifest } from "./manifest.js"

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  )
}

export function stablePluginJson(value: unknown): string {
  return JSON.stringify(stable(value))
}

export function permissionsHashPayload(
  manifest: PluginManifest,
  capabilities = manifest.capabilities.map((item) => item.id),
) {
  return {
    capabilities: manifest.capabilities.filter((item) => capabilities.includes(item.id)),
    contributionRequirements: manifest.contributions.map((item) => ({
      kind: item.kind,
      id: item.id,
      requires: item.requires ?? [],
      ...(item.kind === "operation" ? { expose: item.expose } : {}),
      ...(hasTrustedUIComponent(item) ? { trustedComponent: true } : {}),
    })),
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stablePluginJson(value)).digest("hex")
}

export function computePermissionsHash(
  manifest: PluginManifest,
  capabilities = manifest.capabilities.map((item) => item.id),
): string {
  return sha256(permissionsHashPayload(manifest, capabilities))
}

export function computeManifestHash(manifest: PluginManifest): string {
  return sha256(manifest)
}

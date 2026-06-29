import type { PluginManifest } from "./manifest"

export type PluginRisk = "low" | "medium" | "high"

type ManifestTool = NonNullable<NonNullable<PluginManifest["contributes"]>["tools"]>[number]

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      result[key] = sortKeys(item)
    }
    return result
  }
  return value
}

function buildCapabilitySet(
  permissions: PluginManifest["permissions"],
  toolOverrides?: ManifestTool["capabilities"],
): string[] {
  const caps = new Set<string>()
  const pt = permissions?.tools
  const pd = permissions?.data
  const tc = toolOverrides

  const fs = tc?.filesystem ?? pt?.filesystem ?? "none"
  if (fs === "read") caps.add("filesystem:read")
  if (fs === "write") {
    caps.add("filesystem:read")
    caps.add("filesystem:write")
  }

  if (tc?.shell ?? pt?.shell ?? false) caps.add("shell")
  if (tc?.network ?? pt?.network ?? false) caps.add("network")

  if (pt?.mcp === "invoke") caps.add("mcp:invoke")
  if (pt?.mcp === "spawn") {
    caps.add("mcp:invoke")
    caps.add("mcp:spawn")
  }

  if (pt?.task) caps.add("task")

  const sess = tc?.session ?? pd?.session ?? "none"
  if (sess === "read") caps.add("session_data")

  const ws = tc?.workspace ?? pd?.workspace ?? "none"
  if (ws === "read") caps.add("workspace_data")

  const cfg = tc?.config ?? pd?.config ?? "plugin"
  if (cfg === "global") {
    caps.add("config:read")
    caps.add("config:write")
  }
  if (cfg === "plugin") caps.add("config:read")

  if (pd?.secrets === "own") caps.add("secrets")

  return [...caps].sort()
}

export function baseCapabilities(manifest: PluginManifest): string[] {
  return buildCapabilitySet(manifest.permissions)
}

export function toolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  return buildCapabilitySet(manifest.permissions, tool.capabilities)
}

export function computeRisk(capabilities: string[], manifest?: PluginManifest): PluginRisk {
  if (capabilities.length === 0) return "low"

  let risk: PluginRisk = "low"

  for (const cap of capabilities) {
    switch (cap) {
      case "shell":
      case "filesystem:write":
      case "secrets":
      case "hooks.promptTransform":
        risk = "high"
        break
      case "filesystem:read":
      case "session_data":
      case "config:write":
      case "task":
        if (risk !== "high") risk = "medium"
        break
      case "network":
        if (risk === "high") break
        risk = (manifest?.permissions?.network?.connectDomains ?? []).length > 0 ? "medium" : "high"
        break
      default:
        break
    }
  }

  return risk
}

export function permissionsHashPayload(manifest: PluginManifest, capabilities: string[]) {
  return {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: manifest.contributes ?? {},
    lifecycle: manifest.lifecycle ?? {},
  }
}

export function manifestHashPayload(manifest: PluginManifest): PluginManifest {
  return manifest
}

export function stablePluginJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

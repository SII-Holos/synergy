import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

type ManifestTool = NonNullable<NonNullable<PluginManifest["contributes"]>["tools"]>[number]

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

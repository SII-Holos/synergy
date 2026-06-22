import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityWarning {
  type: "undeclared_tool" | "capability_mismatch" | "missing_manifest"
  message: string
  toolId?: string
}

export interface ResolvedPluginCapability {
  pluginId: string
  /** Capability strings matching gate.ts manifest-style format (e.g. "filesystem:read", "shell", "network") */
  base: string[]
  /** Tool ID (short name) → per-tool capability strings */
  tools: Record<string, string[]>
  /** High-level risk summary */
  overallRisk: "low" | "medium" | "high"
  /** Warnings about undeclared or mismatched capabilities */
  warnings: CapabilityWarning[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ManifestTool = NonNullable<NonNullable<PluginManifest["contributes"]>["tools"]>[number]

/** Compute plugin-wide base capability strings from permissions. */
function baseCapabilities(manifest: PluginManifest): string[] {
  const caps = new Set<string>(["plugin_invoke"])
  const pt = manifest.permissions?.tools

  if (pt) {
    if (pt.filesystem === "read") caps.add("filesystem:read")
    if (pt.filesystem === "write") {
      caps.add("filesystem:read")
      caps.add("filesystem:write")
    }
    if (pt.shell) caps.add("shell")
    if (pt.network) caps.add("network")
    if (pt.mcp === "invoke") caps.add("mcp:invoke")
    if (pt.mcp === "spawn") {
      caps.add("mcp:invoke")
      caps.add("mcp:spawn")
    }
  }

  const pd = manifest.permissions?.data
  if (pd) {
    if (pd.session === "read") caps.add("session_data")
    if (pd.workspace === "read") caps.add("workspace_data")
    if (pd.config === "global") {
      caps.add("config:read")
      caps.add("config:write")
    }
    if (pd.config === "plugin") caps.add("config:read")
    if (pd.secrets === "own") caps.add("secrets")
  }

  return [...caps].sort()
}

/** Compute merged capabilities for a single tool: base defaults → tool-level overrides. */
function mergedToolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  const caps = new Set<string>(["plugin_invoke"])
  const pt = manifest.permissions?.tools
  const pd = manifest.permissions?.data
  const tc = tool.capabilities

  // Filesystem — tool-level wins over plugin-wide default
  const fs = tc?.filesystem ?? pt?.filesystem ?? "none"
  if (fs === "read") caps.add("filesystem:read")
  if (fs === "write") {
    caps.add("filesystem:read")
    caps.add("filesystem:write")
  }

  // Network — tool-level wins
  const net = tc?.network ?? pt?.network ?? false
  if (net) caps.add("network")

  // Shell — tool-level wins
  const shell = tc?.shell ?? pt?.shell ?? false
  if (shell) caps.add("shell")

  // MCP — plugin-wide only (no per-tool override in manifest)
  if (pt?.mcp === "invoke") caps.add("mcp:invoke")
  if (pt?.mcp === "spawn") {
    caps.add("mcp:invoke")
    caps.add("mcp:spawn")
  }

  // Session — tool-level wins over plugin-wide default
  const sess = tc?.session ?? pd?.session ?? "none"
  if (sess === "read") caps.add("session_data")

  // Workspace — tool-level wins
  const ws = tc?.workspace ?? pd?.workspace ?? "none"
  if (ws === "read") caps.add("workspace_data")

  // Config — tool-level wins
  const cfg = tc?.config ?? pd?.config ?? "plugin"
  if (cfg === "global") {
    caps.add("config:read")
    caps.add("config:write")
  }
  if (cfg === "plugin") caps.add("config:read")

  // Secrets — plugin-wide only (no per-tool override in manifest)
  if (pd?.secrets === "own") caps.add("secrets")

  return [...caps].sort()
}

/** Derive overall risk from per-tool risk declarations and permission breadth. */
function overallRisk(manifest: PluginManifest, manifestTools: ManifestTool[]): "low" | "medium" | "high" {
  // Highest risk from per-tool declarations
  let maxToolRisk: "low" | "medium" | "high" = "low"
  for (const t of manifestTools) {
    if (t.risk === "high") maxToolRisk = "high"
    else if (t.risk === "medium" && maxToolRisk !== "high") maxToolRisk = "medium"
  }

  // Risk from plugin-wide permission breadth
  const pt = manifest.permissions?.tools
  let permRisk: "low" | "medium" | "high" = "low"
  if (pt?.shell || pt?.filesystem === "write") {
    permRisk = "high"
  } else if (pt?.network || pt?.mcp === "spawn" || pt?.filesystem === "read") {
    permRisk = "medium"
  }

  if (maxToolRisk === "high" || permRisk === "high") return "high"
  if (maxToolRisk === "medium" || permRisk === "medium") return "medium"
  return "low"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve capabilities from a plugin manifest.
 *
 * If manifest is null (no plugin.json), returns a minimal default with warnings.
 */
export function resolve(input: {
  pluginId: string
  manifest: PluginManifest | null
  /** Tool IDs (short names) registered by the plugin at runtime via hooks.tool */
  declaredTools: string[]
  /** Full plugin__x__y IDs for all runtime tools (reserved for future cross-validation) */
  runtimeToolIds: string[]
}): ResolvedPluginCapability {
  const { pluginId, manifest, declaredTools } = input
  const warnings: CapabilityWarning[] = []

  if (!manifest) {
    warnings.push({
      type: "missing_manifest",
      message: `Plugin "${pluginId}" has no plugin.json manifest; using conservative defaults.`,
    })
    return {
      pluginId,
      base: ["plugin_invoke"],
      tools: Object.fromEntries(declaredTools.map((t) => [t, ["plugin_invoke"]])),
      overallRisk: "low",
      warnings,
    }
  }

  const base = baseCapabilities(manifest)

  const manifestTools = manifest.contributes?.tools ?? []
  const manifestToolByName = new Map(manifestTools.map((t) => [t.name, t]))

  // Build per-tool capability map
  const tools: Record<string, string[]> = {}
  for (const toolId of declaredTools) {
    const manifestTool = manifestToolByName.get(toolId)
    if (!manifestTool) {
      warnings.push({
        type: "undeclared_tool",
        message: `Tool "${toolId}" is registered at runtime but not declared in plugin.json contributes.tools.`,
        toolId,
      })
      tools[toolId] = base
    } else {
      tools[toolId] = mergedToolCapabilities(manifest, manifestTool)
    }
  }

  return {
    pluginId,
    base,
    tools,
    overallRisk: overallRisk(manifest, manifestTools),
    warnings,
  }
}

/**
 * Normalize capabilities for a single tool from manifest declarations.
 *
 * Merges plugin-wide permission defaults with per-tool overrides.
 * Returns `["plugin_invoke"]` when the manifest is null or the tool
 * is not found in contributes.tools.
 */
export function toolCapabilities(manifest: PluginManifest | null, toolId: string): string[] {
  if (!manifest) return ["plugin_invoke"]

  const manifestTool = manifest.contributes?.tools?.find((t) => t.name === toolId || t.id === toolId)
  if (!manifestTool) return baseCapabilities(manifest)

  return mergedToolCapabilities(manifest, manifestTool)
}

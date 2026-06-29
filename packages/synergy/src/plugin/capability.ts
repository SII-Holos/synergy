import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeRisk } from "./consent/risk"

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

/**
 * Build a capability string set from permissions and optional tool-level overrides.
 * When toolOverrides is omitted or a field is absent, falls back to plugin-wide defaults.
 */
function buildCapabilitySet(
  permissions: PluginManifest["permissions"],
  toolOverrides?: ManifestTool["capabilities"],
): string[] {
  const caps = new Set<string>()
  const pt = permissions?.tools
  const pd = permissions?.data
  const tc = toolOverrides

  // Filesystem — tool-level wins over plugin-wide default
  const fs = tc?.filesystem ?? pt?.filesystem ?? "none"
  if (fs === "read") caps.add("filesystem:read")
  if (fs === "write") {
    caps.add("filesystem:read")
    caps.add("filesystem:write")
  }

  // Shell — tool-level wins
  const shell = tc?.shell ?? pt?.shell ?? false
  if (shell) caps.add("shell")

  // Network — tool-level wins
  const net = tc?.network ?? pt?.network ?? false
  if (net) caps.add("network")

  // MCP — plugin-wide only (no per-tool override in manifest)
  if (pt?.mcp === "invoke") caps.add("mcp:invoke")
  if (pt?.mcp === "spawn") {
    caps.add("mcp:invoke")
    caps.add("mcp:spawn")
  }

  // Delegated Synergy tasks — plugin-wide only. This maps to the existing
  // internal "task" permission rather than a separate plugin-only model.
  if (pt?.task) caps.add("task")

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
export function baseCapabilities(manifest: PluginManifest): string[] {
  return buildCapabilitySet(manifest.permissions)
}

/** Compute merged capabilities for a single tool: base defaults → tool-level overrides. */
function mergedToolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  return buildCapabilitySet(manifest.permissions, tool.capabilities)
}
/** Derive overall risk by delegating to the canonical consent/risk calculator. */
function overallRisk(manifest: PluginManifest, _manifestTools: ManifestTool[]): "low" | "medium" | "high" {
  return computeRisk(baseCapabilities(manifest), manifest)
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
      base: [],
      tools: Object.fromEntries(declaredTools.map((t) => [t, []])),
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
 * Returns an empty set when the manifest is null. If the tool is not
 * declared in contributes.tools, plugin-wide permission defaults apply.
 */
export function toolCapabilities(manifest: PluginManifest | null, toolId: string): string[] {
  if (!manifest) return []

  const manifestTool = manifest.contributes?.tools?.find((t) => t.name === toolId || t.id === toolId)
  if (!manifestTool) return baseCapabilities(manifest)

  return mergedToolCapabilities(manifest, manifestTool)
}

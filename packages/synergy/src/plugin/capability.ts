import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import {
  baseCapabilities as sharedBaseCapabilities,
  computeRisk,
  pluginRisk,
  toolCapabilities as sharedToolCapabilities,
  toolRisk as sharedToolRisk,
} from "@ericsanchezok/synergy-plugin/permissions"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityWarning {
  type: "undeclared_tool" | "capability_mismatch"
  message: string
  toolId?: string
}

export interface ResolvedPluginCapability {
  pluginId: string
  /** Synergy capability classes (e.g. "file_read", "shell", "network_request") */
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

export function baseCapabilities(manifest: PluginManifest): string[] {
  return sharedBaseCapabilities(manifest)
}

/** Compute merged capabilities for a single tool: base defaults → tool-level overrides. */
function mergedToolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  return sharedToolCapabilities(manifest, tool)
}
/** Derive overall risk by delegating to the canonical consent/risk calculator. */
function overallRisk(manifest: PluginManifest, _manifestTools: ManifestTool[]): "low" | "medium" | "high" {
  return pluginRisk(manifest, { scope: "install" })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve capabilities from a plugin manifest.
 */
export function resolve(input: {
  pluginId: string
  manifest: PluginManifest
  /** Tool IDs (short names) registered by the plugin at runtime via hooks.tool */
  declaredTools: string[]
  /** Full plugin__x__y IDs for all runtime tools (reserved for future cross-validation) */
  runtimeToolIds: string[]
}): ResolvedPluginCapability {
  const { pluginId, manifest, declaredTools } = input
  const warnings: CapabilityWarning[] = []

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
 * If the tool is not declared in contributes.tools, plugin-wide permission defaults apply.
 */
export function toolCapabilities(manifest: PluginManifest, toolId: string): string[] {
  const manifestTool = manifest.contributes?.tools?.find((t) => t.name === toolId || t.id === toolId)
  if (!manifestTool) return baseCapabilities(manifest)

  return mergedToolCapabilities(manifest, manifestTool)
}

export function toolRisk(manifest: PluginManifest, toolId: string): "low" | "medium" | "high" {
  const manifestTool = manifest.contributes?.tools?.find((t) => t.name === toolId || t.id === toolId)
  if (!manifestTool) return computeRisk(baseCapabilities(manifest), manifest)
  return sharedToolRisk(manifest, manifestTool)
}

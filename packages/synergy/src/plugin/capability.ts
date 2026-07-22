import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"

export interface CapabilityWarning {
  type: "undeclared_tool" | "capability_mismatch"
  message: string
  toolId?: string
}

export interface ResolvedPluginCapability {
  pluginId: string
  base: string[]
  tools: Record<string, string[]>
  overallRisk: "low" | "medium" | "high"
  warnings: CapabilityWarning[]
}

export function baseCapabilities(manifest: PluginManifestType): string[] {
  return manifest.capabilities.map((capability) => capability.id)
}

export function riskForCapabilities(capabilities: string[]): "low" | "medium" | "high" {
  if (
    capabilities.some((capability) =>
      [
        "session.control",
        "workspace.write",
        "task.delegate",
        "blueprint.delegate",
        "lightloop.delegate",
        "secrets",
        "tool.invoke",
        "composer.write",
        "composer.intercept",
        "agent.call",
      ].includes(capability),
    )
  ) {
    return "high"
  }
  if (
    capabilities.some((capability) =>
      ["session.read", "workspace.read", "settings.write", "composer.read", "selection.read"].includes(capability),
    )
  ) {
    return "medium"
  }
  return "low"
}

export function toolCapabilities(manifest: PluginManifestType, toolId: string): string[] {
  const tool = manifest.contributions.find((item) => item.kind === "tool" && item.id === toolId)
  return tool?.requires ?? []
}

export function toolRisk(manifest: PluginManifestType, toolId: string) {
  return riskForCapabilities(toolCapabilities(manifest, toolId))
}

export function resolve(input: {
  pluginId: string
  manifest: PluginManifestType
  declaredTools?: string[]
}): ResolvedPluginCapability {
  const declaredTools =
    input.declaredTools ?? input.manifest.contributions.filter((item) => item.kind === "tool").map((item) => item.id)
  const tools = Object.fromEntries(declaredTools.map((toolId) => [toolId, toolCapabilities(input.manifest, toolId)]))
  const base = baseCapabilities(input.manifest)
  return { pluginId: input.pluginId, base, tools, overallRisk: riskForCapabilities(base), warnings: [] }
}

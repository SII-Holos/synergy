import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"

export { controlProfileCapability, hasControlProfileCapability } from "../control-profile/host-capability"

export interface CapabilityWarning {
  type: "undeclared_tool" | "capability_mismatch"
  message: string
  toolId?: string
}

export interface ResolvedPluginCapability {
  pluginId: string
  base: string[]
  tools: Record<string, string[]>
  warnings: CapabilityWarning[]
}

export function baseCapabilities(manifest: PluginManifestType): string[] {
  return manifest.capabilities.map((capability) => capability.id)
}

export function toolCapabilities(manifest: PluginManifestType, toolId: string): string[] {
  const tool = manifest.contributions.find((item) => item.kind === "tool" && item.id === toolId)
  return tool?.requires ?? []
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
  return { pluginId: input.pluginId, base, tools, warnings: [] }
}

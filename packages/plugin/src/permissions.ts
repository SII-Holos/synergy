import type { PluginManifest } from "./manifest"
import type {
  BridgeMethodPolicy,
  RegistryPermissionItem,
  SynergyCapabilityCategory,
  SynergyCapabilityDefinition,
  SynergyCapabilityManifest,
  SynergyCapabilityPermissionItem,
  SynergyCapabilityRisk,
  SynergyCapabilityRiskScope,
  SynergyCapabilitySeverity,
} from "@ericsanchezok/synergy-util/capability"
import {
  SYNERGY_CAPABILITY_CATEGORIES,
  SYNERGY_CAPABILITY_DETAILS,
  SYNERGY_PERMISSION_CAPABILITY,
  SYNERGY_PROFILE_CAPABILITIES,
  baseCapabilities as sharedBaseCapabilities,
  bridgeCapability as sharedBridgeCapability,
  bridgeMethodPolicy as sharedBridgeMethodPolicy,
  capabilitiesForRiskScope as sharedCapabilitiesForRiskScope,
  capabilityNonBypassable,
  capabilityRisk as sharedCapabilityRisk,
  computeRisk as sharedComputeRisk,
  hasPublicTools,
  manifestHashPayload as sharedManifestHashPayload,
  permissionCategoryForKey,
  permissionCapability,
  permissionItems as sharedPermissionItems,
  permissionsHashPayload as sharedPermissionsHashPayload,
  pluginRisk as sharedPluginRisk,
  publicToolCapabilities as sharedPublicToolCapabilities,
  publicToolNames,
  registryPermissionSummary as sharedRegistryPermissionSummary,
  stablePluginJson,
  toolCapabilities as sharedToolCapabilities,
  toolRisk as sharedToolRisk,
  SYNERGY_BRIDGE_METHOD_POLICY,
} from "@ericsanchezok/synergy-util/capability"

export type PluginRisk = SynergyCapabilityRisk
export type PluginRiskScope = SynergyCapabilityRiskScope
export const PLUGIN_PERMISSION_CATEGORIES = SYNERGY_CAPABILITY_CATEGORIES
export type PluginPermissionCategory = SynergyCapabilityCategory
export type PluginPermissionSeverity = SynergyCapabilitySeverity
export type PluginPermissionItem = SynergyCapabilityPermissionItem
export type PluginBridgeMethodPolicy = BridgeMethodPolicy
export type { RegistryPermissionItem, SynergyCapabilityDefinition }
export type ManifestTool = NonNullable<NonNullable<PluginManifest["contributes"]>["tools"]>[number]

export const CAPABILITY_DETAILS = SYNERGY_CAPABILITY_DETAILS
export const PROFILE_CAPABILITIES = SYNERGY_PROFILE_CAPABILITIES
export const PERMISSION_CAPABILITY = SYNERGY_PERMISSION_CAPABILITY
export const PLUGIN_BRIDGE_METHOD_POLICY = SYNERGY_BRIDGE_METHOD_POLICY
export {
  capabilityNonBypassable,
  hasPublicTools,
  permissionCapability,
  permissionCategoryForKey,
  publicToolNames,
  stablePluginJson,
}

export const pluginBridgeMethodPolicy = sharedBridgeMethodPolicy

function asCapabilityManifest(manifest: PluginManifest): SynergyCapabilityManifest {
  return manifest as SynergyCapabilityManifest
}

export function capabilityRisk(capability: string, manifest?: PluginManifest): PluginRisk {
  return sharedCapabilityRisk(capability, manifest ? asCapabilityManifest(manifest) : undefined)
}

export function baseCapabilities(manifest: PluginManifest): string[] {
  return sharedBaseCapabilities(asCapabilityManifest(manifest))
}

export function toolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  return sharedToolCapabilities(asCapabilityManifest(manifest), tool)
}

export function publicToolCapabilities(manifest: PluginManifest): string[] {
  return sharedPublicToolCapabilities(asCapabilityManifest(manifest))
}

export function computeRisk(capabilities: string[], manifest?: PluginManifest): PluginRisk {
  return sharedComputeRisk(capabilities, manifest ? asCapabilityManifest(manifest) : undefined)
}

export function capabilitiesForRiskScope(manifest: PluginManifest, scope: PluginRiskScope): string[] {
  return sharedCapabilitiesForRiskScope(asCapabilityManifest(manifest), scope)
}

export function pluginRisk(manifest: PluginManifest, input: { scope: PluginRiskScope }): PluginRisk {
  return sharedPluginRisk(asCapabilityManifest(manifest), input)
}

export function toolRisk(manifest: PluginManifest, tool: ManifestTool): PluginRisk {
  return sharedToolRisk(asCapabilityManifest(manifest), tool)
}

export function permissionItems(manifest: PluginManifest, capabilities: string[]): PluginPermissionItem[] {
  return sharedPermissionItems(asCapabilityManifest(manifest), capabilities)
}

export function registryPermissionSummary(manifest: PluginManifest, capabilities: string[]): RegistryPermissionItem[] {
  return sharedRegistryPermissionSummary(asCapabilityManifest(manifest), capabilities)
}

export function permissionsHashPayload(manifest: PluginManifest, capabilities: string[]) {
  return sharedPermissionsHashPayload(asCapabilityManifest(manifest), capabilities)
}

export function manifestHashPayload(manifest: PluginManifest): PluginManifest {
  return sharedManifestHashPayload(asCapabilityManifest(manifest)) as PluginManifest
}

export function bridgeCapability(method: string): string | undefined {
  return sharedBridgeCapability(method)
}

export const pluginBridgeMethodCapability = bridgeCapability
